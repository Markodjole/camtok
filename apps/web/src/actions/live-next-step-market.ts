"use server";

import { unstable_noStore } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import type { LiveMarketOption } from "@bettok/live";
import { fetchGoogleDirectionsRoute } from "@/lib/live/routing/googleDirections";
import { metersBetween, bearingDegrees, type LatLng } from "@/lib/live/routing/geometry";
import {
  normalizeDrivingRouteStyle,
  type DrivingRouteStyle,
} from "@/lib/live/routing/drivingRouteStyle";
import { computeEqualOdds } from "@/lib/live/betting/marketOdds";
import { bustPlanningRouteCache } from "@/lib/live/routing/computeDriverRouteInstruction";
import { BET_OPEN_WINDOW_IDLE_MS, MIN_VIABLE_STEP_BET_DIST_M } from "@/lib/live/betting/betWindowConstants";

/**
 * `next_step`: bet on whether the driver reaches the next OSRM step maneuver
 * point (a real turn/roundabout/merge on the planned road) faster or slower
 * than the Google Maps projected ETA.
 *
 * Market lifecycle
 * ────────────────
 * • Opens when the first OSRM step maneuver point that lies on the same road
 *   as the Google planning polyline is NEXT_STEP_MIN_M – NEXT_STEP_MAX_M ahead.
 * • The ETA reference (T seconds) is derived by walking the Google route
 *   polyline from the driver to the step maneuver point and using the
 *   proportional share of the total route duration.
 * • Bets lock after BET_OPEN_WINDOW_IDLE_MS (12 s).
 * • Settlement: driver comes within NEXT_STEP_APPROACH_M of the maneuver point
 *   and starts moving away, or reveal_at safety cap fires.
 *
 * Subtitle schema (JSON)
 * ──────────────────────
 * {
 *   stepKey:          string;   // de-dupe key "step:{lat4}:{lng4}"
 *   stepLat:          number;
 *   stepLng:          number;
 *   estimatedSec:     number;   // T = Google-projected seconds to maneuver
 *   estimateSource:   "google_route" | "speed";
 *   maneuverType:     string;   // "turn", "roundabout", etc.
 *   maneuverModifier: string | undefined; // "left", "right", "straight", etc.
 *   stepName:         string;   // road name at the maneuver
 * }
 */

export type NextStepSubtitle = {
  stepKey: string;
  stepLat: number;
  stepLng: number;
  estimatedSec: number;
  estimateSource: "google_route" | "speed";
  maneuverType: string;
  maneuverModifier?: string;
  stepName: string;
};

export async function openNextStepMarketForRoom(
  roomId: string,
  opts?: {
    windowMs?: number;
    /** Pre-computed step data from the tick trigger detector. */
    stepKey?: string;
    stepLat?: number;
    stepLng?: number;
    maneuverType?: string;
    maneuverModifier?: string;
    stepName?: string;
  },
): Promise<{ marketId: string; betType: "next_step" } | { error: string }> {
  unstable_noStore();
  const service = await createServiceClient();

  // ── Load room + session ───────────────────────────────────────────────────
  const { data: room } = await service
    .from("live_rooms")
    .select("id, live_session_id, phase")
    .eq("id", roomId)
    .maybeSingle();
  if (!room) return { error: "room_not_found" };
  if ((room as { phase: string }).phase !== "waiting_for_next_market") {
    return { error: "room_not_in_waiting_phase" };
  }

  const sessionId = (room as { live_session_id: string | null }).live_session_id;
  if (!sessionId) return { error: "no_live_session" };

  const { data: sessionRow } = await service
    .from("character_live_sessions")
    .select("id, character_id, destination_lat, destination_lng, transport_mode")
    .eq("id", sessionId)
    .maybeSingle();
  if (!sessionRow) return { error: "session_not_found" };

  const session = sessionRow as {
    character_id: string;
    destination_lat: number | null;
    destination_lng: number | null;
    transport_mode: string | null;
  };

  // ── Require pre-computed step data (from tick trigger detector) ───────────
  if (
    opts?.stepKey == null ||
    opts.stepLat == null ||
    opts.stepLng == null ||
    opts.maneuverType == null
  ) {
    return { error: "next_step: missing pre-computed step data" };
  }

  const stepKey = opts.stepKey;
  const stepLat = opts.stepLat;
  const stepLng = opts.stepLng;
  const maneuverType = opts.maneuverType;
  const maneuverModifier = opts.maneuverModifier;
  const stepName = opts.stepName ?? "";

  // ── De-dupe: skip if this step was already bet on this session ────────────
  const { data: prior } = await service
    .from("live_betting_markets")
    .select("id, subtitle")
    .eq("live_session_id", sessionId)
    .eq("market_type", "next_step")
    .order("opens_at", { ascending: false })
    .limit(10);

  const alreadyFired = (prior ?? []).some((row) => {
    try {
      const meta = JSON.parse(
        (row as { subtitle: string | null }).subtitle ?? "{}",
      ) as { stepKey?: string };
      return meta.stepKey === stepKey;
    } catch {
      return false;
    }
  });
  if (alreadyFired) {
    return { error: `next_step: stepKey ${stepKey} already bet this session` };
  }

  // ── Load driver position for ETA calculation ──────────────────────────────
  const { data: gpsRow } = await service
    .from("live_route_snapshots")
    .select("normalized_lat, normalized_lng, raw_lat, raw_lng, heading_deg, speed_mps")
    .eq("live_session_id", sessionId)
    .order("recorded_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!gpsRow) return { error: "next_step: no gps data" };

  const g = gpsRow as {
    normalized_lat: number | null;
    normalized_lng: number | null;
    raw_lat: number;
    raw_lng: number;
    heading_deg: number | null;
    speed_mps: number | null;
  };
  const driverLat = g.normalized_lat ?? g.raw_lat;
  const driverLng = g.normalized_lng ?? g.raw_lng;
  const driverHeadingDeg = g.heading_deg;
  const speedMps = g.speed_mps;

  // ── Character name ─────────────────────────────────────────────────────────
  const { data: characterRow } = await service
    .from("characters")
    .select("name")
    .eq("id", session.character_id)
    .maybeSingle();
  const characterName = (characterRow as { name: string } | null)?.name ?? "the driver";

  // ── Estimate ETA to step maneuver point ───────────────────────────────────
  bustPlanningRouteCache(roomId);

  const drivingRouteStyle = await loadDrivingRouteStyle(service, session.character_id);

  const destination =
    session.destination_lat != null && session.destination_lng != null
      ? { lat: session.destination_lat, lng: session.destination_lng }
      : null;

  const stepTarget: LatLng = { lat: stepLat, lng: stepLng };
  const driver: LatLng = { lat: driverLat, lng: driverLng };

  // Guard: if the pin is already within MIN_VIABLE_STEP_BET_DIST_M, the driver
  // is essentially at or past it — the bet would resolve within a second or two.
  // Prefix "SKIP:" signals permanent rejection (trigger must not be re-queued).
  const distToPin = metersBetween(driver, stepTarget);
  if (distToPin < MIN_VIABLE_STEP_BET_DIST_M) {
    console.log(
      `[next_step] SKIP: pin ${Math.round(distToPin)}m away (min ${MIN_VIABLE_STEP_BET_DIST_M}m) — already passed or too close`,
      { roomId, stepKey },
    );
    return { error: `SKIP:next_step: pin ${Math.round(distToPin)}m away (min ${MIN_VIABLE_STEP_BET_DIST_M}m)` };
  }

  const FALLBACK_MIN_SPEED_MPS = 7;

  const estimate = await estimateSecToStep({
    driver,
    destination,
    stepTarget,
    driverHeadingDeg,
    transportMode: session.transport_mode,
    drivingRouteStyle,
    fallbackSpeedMps: Math.max(FALLBACK_MIN_SPEED_MPS, speedMps ?? FALLBACK_MIN_SPEED_MPS),
  });

  const T = estimate.sec;

  // ── Build options ─────────────────────────────────────────────────────────
  const maneuverLabel = formatManeuverLabel(maneuverType, maneuverModifier, stepName);

  const options: LiveMarketOption[] = [
    {
      id: "step_under",
      label: `Reaches ${maneuverLabel} in under ${T} seconds`,
      shortLabel: `< ${T}s`,
      displayOrder: 0,
    },
    {
      id: "step_at",
      label: `Reaches ${maneuverLabel} in about ${T} seconds (±20%)`,
      shortLabel: `≈ ${T}s`,
      displayOrder: 1,
    },
    {
      id: "step_over",
      label: `Takes more than ${T} seconds to reach ${maneuverLabel}`,
      shortLabel: `> ${T}s`,
      displayOrder: 2,
    },
  ];

  const odds = computeEqualOdds(options);

  const subtitle: NextStepSubtitle = {
    stepKey,
    stepLat,
    stepLng,
    estimatedSec: T,
    estimateSource: estimate.source,
    maneuverType,
    maneuverModifier,
    stepName,
  };

  // ── Timing ────────────────────────────────────────────────────────────────
  const now = new Date();
  const windowMs = opts?.windowMs ?? BET_OPEN_WINDOW_IDLE_MS;
  const locksAt = new Date(now.getTime() + windowMs);
  // Safety cap: T + 20 s grace period, minimum 45 s.
  // If the proximity condition hasn't fired 20 s after the ETA the bet
  // force-settles via reveal_timeout so the spinner never runs forever.
  const revealMs = Math.max(45_000, T * 1_000 + 20_000);
  const revealAt = new Date(now.getTime() + revealMs);

  // ── Insert market ─────────────────────────────────────────────────────────
  const { data: market, error: marketError } = await service
    .from("live_betting_markets")
    .insert({
      room_id: roomId,
      live_session_id: sessionId,
      source: "system_generated",
      title: `How fast does ${characterName} reach the next pin?`,
      subtitle: JSON.stringify(subtitle),
      market_type: "next_step",
      option_set: options,
      odds: odds as unknown as Record<string, unknown>,
      opens_at: now.toISOString(),
      locks_at: locksAt.toISOString(),
      reveal_at: revealAt.toISOString(),
      status: "open",
      // Store the step maneuver point so the resolution sweep can use
      // the existing turn_pin_proximity condition without any special casing.
      turn_point_lat: stepLat,
      turn_point_lng: stepLng,
    })
    .select("*")
    .single();

  if (marketError || !market) {
    return { error: marketError?.message ?? "market_insert_failed" };
  }

  await service
    .from("live_rooms")
    .update({
      phase: "market_open",
      current_market_id: (market as { id: string }).id,
      last_event_at: now.toISOString(),
    })
    .eq("id", roomId);

  await service.from("live_room_events").insert({
    room_id: roomId,
    market_id: (market as { id: string }).id,
    event_type: "market_open",
    payload: {
      title: `How fast does ${characterName} reach the next pin?`,
      optionCount: options.length,
      betType: "next_step",
      stepKey,
      estimatedSec: T,
      maneuverType,
    },
  });

  console.log(`[next_step] opened market ${(market as { id: string }).id}`, {
    roomId,
    stepKey,
    stepLat,
    stepLng,
    estimatedSec: T,
    estimateSource: estimate.source,
    maneuverType,
    maneuverModifier,
  });

  return { marketId: (market as { id: string }).id, betType: "next_step" };
}

// ─── ETA estimation ───────────────────────────────────────────────────────

/**
 * Estimate the driving time from `driver` to `stepTarget` by walking the
 * Google route polyline to the closest point to `stepTarget` and using the
 * proportional share of the total route duration.
 *
 * Falls back to straight-line distance / speed if Google is unavailable.
 */
async function estimateSecToStep(params: {
  driver: LatLng;
  destination: LatLng | null;
  stepTarget: LatLng;
  driverHeadingDeg: number | null;
  transportMode: string | null;
  drivingRouteStyle: DrivingRouteStyle | null;
  fallbackSpeedMps: number;
}): Promise<{ sec: number; source: "google_route" | "speed" }> {
  const {
    driver,
    destination,
    stepTarget,
    driverHeadingDeg,
    transportMode,
    drivingRouteStyle,
    fallbackSpeedMps,
  } = params;

  const speedFallback = (): { sec: number; source: "speed" } => ({
    sec: roundCleanSec(metersBetween(driver, stepTarget) / fallbackSpeedMps),
    source: "speed",
  });

  if (!destination) return speedFallback();

  const route = await fetchGoogleDirectionsRoute(driver, destination, {
    transportMode: transportMode ?? undefined,
    drivingRouteStyle,
  });
  if (!route || route.polyline.length < 2) return speedFallback();

  // Heading sanity check — make sure the route starts in the driver's direction.
  if (driverHeadingDeg != null) {
    const firstFar = route.polyline.find((p) => metersBetween(driver, p) > 15);
    if (firstFar) {
      const routeBearing = bearingDegrees(driver, firstFar);
      let diff = Math.abs(routeBearing - driverHeadingDeg) % 360;
      if (diff > 180) diff = 360 - diff;
      if (diff > 90) return speedFallback();
    }
  }

  // Walk the polyline from driver and find the segment closest to stepTarget.
  const points: LatLng[] = [driver, ...route.polyline];
  let travelledM = 0;
  let closestM = Number.POSITIVE_INFINITY;
  let closestTravelledM = 0;

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const segM = metersBetween(a, b);
    if (segM <= 0) continue;

    // Check proximity of segment midpoint AND endpoints to stepTarget.
    const mid: LatLng = { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
    for (const p of [a, mid, b]) {
      const d = metersBetween(p, stepTarget);
      if (d < closestM) {
        closestM = d;
        closestTravelledM =
          p === a
            ? travelledM
            : p === mid
              ? travelledM + segM / 2
              : travelledM + segM;
      }
    }

    travelledM += segM;
  }

  // If we never got within a generous radius, fall back to speed estimate.
  if (closestM > 200) return speedFallback();

  const raw =
    route.distanceMeters > 0 && route.durationSec > 0
      ? route.durationSec * (closestTravelledM / route.distanceMeters)
      : closestTravelledM / Math.max(1, fallbackSpeedMps);

  return { sec: roundCleanSec(raw), source: "google_route" };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function roundCleanSec(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 30;
  return Math.max(5, Math.min(300, Math.round(raw / 5) * 5));
}

function formatManeuverLabel(
  type: string,
  modifier: string | undefined,
  name: string,
): string {
  if (type === "camera") return "the speed camera";
  const dir = modifier ? ` ${modifier}` : "";
  const road = name ? ` onto ${name}` : "";
  return `${type}${dir}${road}`.trim() || "the pin";
}

async function loadDrivingRouteStyle(
  service: Awaited<ReturnType<typeof createServiceClient>>,
  characterId: string | null,
): Promise<DrivingRouteStyle | null> {
  if (!characterId) return null;
  const { data } = await service
    .from("characters")
    .select("driving_route_style")
    .eq("id", characterId)
    .maybeSingle();
  return normalizeDrivingRouteStyle(
    (data as { driving_route_style: unknown } | null)?.driving_route_style,
  );
}
