"use server";

import { unstable_noStore } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import type { BetTypeV2, LiveMarketOption } from "@bettok/live";
import { metersBetween } from "@/lib/live/routing/geometry";
import { computeEqualOdds } from "@/lib/live/betting/marketOdds";
import {
  BET_OPEN_WINDOW_MS,
  ZONE_EXIT_CENTER_TRIGGER_M,
  ZONE_EXIT_OUTER_TRIGGER_MIN_M,
} from "@/lib/live/betting/betWindowConstants";
import {
  cellIdForPosition,
  gridCellCenter,
  parseGridOptionId,
  type CityGridSpecCompact,
} from "@/lib/live/grid/cityGrid500";
import { getOrBuildGridSpecForRoom } from "@/lib/live/grid/gridSpecForRoom";

export type ZoneExitPhase = "entry" | "center_70m" | "exit_outer";

/**
 * `zone_exit_time`: fires up to 3× per zone, in phase order:
 *
 *  "entry"      – immediately when driver is inside the cell (any distance)
 *  "center_70m" – when driver is within ZONE_EXIT_CENTER_TRIGGER_M (70 m) of center
 *  "exit_outer" – when driver moves back past ZONE_EXIT_OUTER_TRIGGER_MIN_M (100 m)
 *                 AFTER "center_70m" has already fired (was close, now moving out)
 *
 * Each phase fires at most once per cell per live session. The tick worker
 * may pass `phase` directly (from the trigger queue) or omit it to let
 * this function detect which phase is currently eligible.
 */
export async function openEngineMarketForRoom(
  roomId: string,
  opts?: { phase?: ZoneExitPhase },
) {
  unstable_noStore();

  const service = await createServiceClient();

  // region_label lives on character_live_sessions, not live_rooms.
  const { data: room } = await service
    .from("live_rooms")
    .select("id, live_session_id, phase")
    .eq("id", roomId)
    .maybeSingle();
  if (!room) return { error: "Room not found" };
  if ((room as { phase: string }).phase !== "waiting_for_next_market") {
    return { error: "Room not in waiting phase" };
  }

  const sessionId = (room as { live_session_id: string }).live_session_id;

  const { data: sessionRow } = await service
    .from("character_live_sessions")
    .select("region_label")
    .eq("id", sessionId)
    .maybeSingle();
  const capturedZone = (sessionRow as { region_label: string | null } | null)?.region_label ?? null;

  const ctx = await loadGridCenterContext(service, sessionId, roomId);
  if (!ctx.ok) return { error: ctx.error };
  const { lat: driverLat, lng: driverLng, headingDeg, speedMps, distanceM, cellKey, center, spec } = ctx;

  // Which phases have already fired for this cell in this session?
  const firedPhases = await loadFiredPhases(service, sessionId, cellKey);

  // Determine which phase to open — either the requested one or the next eligible.
  const candidatePhase = opts?.phase ?? pickEligiblePhase(distanceM, firedPhases);
  if (!candidatePhase) {
    return {
      error: `zone_exit_time: no eligible phase (dist=${Math.round(distanceM)} m, fired=${[...firedPhases].join(",")})`,
    };
  }

  // If the phase is already fired (race condition — a concurrent tick already opened it),
  // look for an existing open market for this phase and recover by pointing the room to it.
  if (firedPhases.has(candidatePhase)) {
    const { data: existing } = await service
      .from("live_betting_markets")
      .select("id, status")
      .eq("live_session_id", sessionId)
      .eq("market_type", "zone_exit_time")
      .eq("status", "open")
      .order("opens_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing && (existing as { id: string; status: string }).status === "open") {
      const existingId = (existing as { id: string }).id;
      await service
        .from("live_rooms")
        .update({ phase: "market_open", current_market_id: existingId, last_event_at: new Date().toISOString() })
        .eq("id", roomId)
        .eq("phase", "waiting_for_next_market");
      return { marketId: existingId, betType: "zone_exit_time" as const, triggerPhase: candidatePhase };
    }
    return { error: `zone_exit_time: phase "${candidatePhase}" already fired for this cell` };
  }

  // Verify the requested phase's gate condition is still met.
  const gateErr = checkPhaseGate(candidatePhase, distanceM, firedPhases);
  if (gateErr) return { error: gateErr };

  const betType: BetTypeV2 = "zone_exit_time";

  // Compute estimated seconds to zone exit from heading/speed/cell geometry.
  const T = estimateZoneExitSec(
    { lat: driverLat, lng: driverLng },
    center,
    headingDeg ?? 0,
    speedMps ?? 5,
    spec,
  );

  // Options use a real computed threshold T so viewers see a meaningful number.
  const options: LiveMarketOption[] = [
    { id: "exit_under", label: `Under ${T} seconds`, shortLabel: `< ${T} s`, displayOrder: 0 },
    { id: "exit_at",    label: `Around ${T} seconds`, shortLabel: `≈ ${T} s`, displayOrder: 1 },
    { id: "exit_over",  label: `Over ${T} seconds`,   shortLabel: `> ${T} s`, displayOrder: 2 },
  ];

  // Equal odds for the 3-way time-bucket bet (5 % margin → 2.86 each).
  const odds = computeEqualOdds(options);

  const title = "Time left in zone";

  const now = new Date();
  const locksAt = new Date(now.getTime() + BET_OPEN_WINDOW_MS);
  const revealAt = new Date(now.getTime() + 5 * 60_000);

  const { data: market, error: marketError } = await service
    .from("live_betting_markets")
    .insert({
      room_id: roomId,
      live_session_id: sessionId,
      source: "system_generated",
      title,
      subtitle: JSON.stringify({ capturedZone, cellKey, triggerPhase: candidatePhase, estimatedSec: T }),
      market_type: betType,
      option_set: options,
      city_grid_spec: spec as unknown as Record<string, unknown>,
      odds: odds as unknown as Record<string, unknown>,
      opens_at: now.toISOString(),
      locks_at: locksAt.toISOString(),
      reveal_at: revealAt.toISOString(),
      status: "open",
      turn_point_lat: null,
      turn_point_lng: null,
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
      current_market_id: market.id,
      last_event_at: now.toISOString(),
    })
    .eq("id", roomId);

  await service.from("live_room_events").insert({
    room_id: roomId,
    market_id: market.id,
    event_type: "market_open",
    payload: { title, optionCount: options.length, betType, triggerPhase: candidatePhase, cellKey },
  });

  return { marketId: market.id as string, betType, triggerPhase: candidatePhase };
}

// ─── Phase helpers ────────────────────────────────────────────────────────────

function pickEligiblePhase(
  distM: number,
  firedPhases: Set<ZoneExitPhase>,
): ZoneExitPhase | null {
  // Entry: fires as soon as driver is in zone (distM exists = they're in cell)
  if (!firedPhases.has("entry")) return "entry";
  // Center: fires when within 70 m of center
  if (!firedPhases.has("center_70m") && distM <= ZONE_EXIT_CENTER_TRIGGER_M) {
    return "center_70m";
  }
  // Exit_outer: fires when driver moves back outward past 100 m, after being at center
  if (
    !firedPhases.has("exit_outer") &&
    firedPhases.has("center_70m") &&
    distM >= ZONE_EXIT_OUTER_TRIGGER_MIN_M
  ) {
    return "exit_outer";
  }
  return null;
}

function checkPhaseGate(
  phase: ZoneExitPhase,
  distM: number,
  firedPhases: Set<ZoneExitPhase>,
): string | null {
  if (firedPhases.has(phase)) {
    return `zone_exit_time: phase "${phase}" already fired for this cell`;
  }
  if (phase === "center_70m" && distM > ZONE_EXIT_CENTER_TRIGGER_M) {
    return `zone_exit_time(center_70m): ${Math.round(distM)} m > ${ZONE_EXIT_CENTER_TRIGGER_M} m`;
  }
  if (phase === "exit_outer") {
    if (!firedPhases.has("center_70m")) {
      return `zone_exit_time(exit_outer): center_70m phase not yet fired`;
    }
    if (distM < ZONE_EXIT_OUTER_TRIGGER_MIN_M) {
      return `zone_exit_time(exit_outer): ${Math.round(distM)} m < ${ZONE_EXIT_OUTER_TRIGGER_MIN_M} m`;
    }
  }
  return null;
}

/** Query which zone_exit_time phases have already fired for this cell in this session. */
async function loadFiredPhases(
  service: Awaited<ReturnType<typeof createServiceClient>>,
  liveSessionId: string,
  cellKey: string,
): Promise<Set<ZoneExitPhase>> {
  const { data } = await service
    .from("live_betting_markets")
    .select("subtitle")
    .eq("live_session_id", liveSessionId)
    .eq("market_type", "zone_exit_time");
  const fired = new Set<ZoneExitPhase>();
  for (const row of data ?? []) {
    try {
      const meta = JSON.parse(
        (row as { subtitle: string | null }).subtitle ?? "{}",
      ) as { cellKey?: string; triggerPhase?: string };
      if (meta.cellKey === cellKey && meta.triggerPhase) {
        fired.add(meta.triggerPhase as ZoneExitPhase);
      }
    } catch {
      // ignore parse errors
    }
  }
  return fired;
}

// ─── Settlement ───────────────────────────────────────────────────────────────

/**
 * Checks whether a zone_exit_time market's settlement condition has been met.
 * Settles when the driver has left the zone captured at market open.
 */
export async function shouldSettleEngineMarket(
  service: Awaited<ReturnType<typeof createServiceClient>>,
  {
    marketId,
    marketType,
    liveSessionId,
    roomId,
  }: {
    marketId: string;
    marketType: string;
    locksAt?: string;
    liveSessionId?: string | null;
    roomId: string;
  },
): Promise<boolean> {
  if (marketType !== "zone_exit_time") return false;

  if (!liveSessionId) return false;

  const { data: marketRow } = await service
    .from("live_betting_markets")
    .select("subtitle, city_grid_spec")
    .eq("id", marketId)
    .maybeSingle();

  const gridSpec = (marketRow as { city_grid_spec: CityGridSpecCompact | null } | null)
    ?.city_grid_spec;
  if (!gridSpec) return false;

  let startCellKey: string | null = null;
  try {
    const meta = JSON.parse(
      (marketRow as { subtitle: string | null } | null)?.subtitle ?? "{}",
    ) as { cellKey?: string | null };
    startCellKey = meta.cellKey ?? null;
  } catch {
    // ignore parse errors
  }
  if (!startCellKey) return false;

  const { data: latestGps } = await service
    .from("live_route_snapshots")
    .select("normalized_lat,normalized_lng,raw_lat,raw_lng")
    .eq("live_session_id", liveSessionId)
    .order("recorded_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!latestGps) return false;

  const g = latestGps as {
    normalized_lat: number | null;
    normalized_lng: number | null;
    raw_lat: number;
    raw_lng: number;
  };
  const currentCell = cellIdForPosition(
    gridSpec,
    g.normalized_lat ?? g.raw_lat,
    g.normalized_lng ?? g.raw_lng,
  );
  if (!currentCell) return false;
  const parsed = parseGridOptionId(currentCell);
  if (!parsed) return false;

  return `cell:r${parsed.row}:c${parsed.col}` !== startCellKey;
}

// ─── Grid center helper ───────────────────────────────────────────────────────

type GridCenterContext =
  | {
      ok: true;
      lat: number;
      lng: number;
      headingDeg: number | null;
      speedMps: number | null;
      distanceM: number;
      cellId: string;
      cellKey: string;
      center: { lat: number; lng: number };
      spec: CityGridSpecCompact;
    }
  | { ok: false; error: string };

async function loadGridCenterContext(
  service: Awaited<ReturnType<typeof createServiceClient>>,
  liveSessionId: string,
  roomId: string,
): Promise<GridCenterContext> {
  const { data: latestGps } = await service
    .from("live_route_snapshots")
    .select("normalized_lat,normalized_lng,raw_lat,raw_lng,heading_deg,speed_mps")
    .eq("live_session_id", liveSessionId)
    .order("recorded_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!latestGps) return { ok: false, error: "Zone gate: no GPS yet" };

  const g = latestGps as {
    normalized_lat: number | null;
    normalized_lng: number | null;
    raw_lat: number;
    raw_lng: number;
    heading_deg: number | null;
    speed_mps: number | null;
  };
  const lat = g.normalized_lat ?? g.raw_lat;
  const lng = g.normalized_lng ?? g.raw_lng;

  const specRes = await getOrBuildGridSpecForRoom(service, roomId, liveSessionId);
  if (!specRes.ok) return { ok: false, error: specRes.error };
  const spec = specRes.spec;

  const cellId = cellIdForPosition(spec, lat, lng);
  if (!cellId) return { ok: false, error: "Zone gate: driver outside grid" };

  const parsed = parseGridOptionId(cellId);
  if (!parsed) return { ok: false, error: "Zone gate: bad cell id" };

  const center = gridCellCenter(spec, parsed.row, parsed.col);
  const distanceM = metersBetween({ lat, lng }, center);
  const cellKey = `cell:r${parsed.row}:c${parsed.col}`;

  return {
    ok: true,
    lat,
    lng,
    headingDeg: g.heading_deg,
    speedMps: g.speed_mps,
    distanceM,
    cellId,
    cellKey,
    center,
    spec,
  };
}

/**
 * Estimate the number of seconds the driver will remain inside the current
 * grid cell, given their position, heading, speed, and the cell geometry.
 *
 * Uses a ray → axis-aligned rectangle intersection: cast a ray from the
 * driver's position in the heading direction and find the closest cell-wall
 * crossing.  distanceToWall / speed = estimated seconds.
 *
 * Result is rounded to the nearest 5 s and clamped to [10, 180] so the
 * bet options are always clean, readable numbers.
 */
function estimateZoneExitSec(
  pos: { lat: number; lng: number },
  center: { lat: number; lng: number },
  headingDeg: number,
  speedMps: number,
  spec: CityGridSpecCompact,
): number {
  const halfLat = spec.dLat / 2; // half-height in degrees
  const halfLng = spec.dLng / 2; // half-width in degrees

  // Current offset from cell center in degrees
  const dy = pos.lat - center.lat; // north component
  const dx = pos.lng - center.lng; // east component

  // Ray direction (unit vector in degree space, scaled by aspect)
  const rad = (headingDeg * Math.PI) / 180;
  const ry = Math.cos(rad); // north
  const rx = Math.sin(rad); // east

  // Find t (in degrees-along-ray) to each wall — take the smallest positive t
  let tMin = Infinity;
  if (Math.abs(rx) > 1e-9) {
    const tE = (halfLng - dx) / rx;
    const tW = (-halfLng - dx) / rx;
    if (tE > 1e-4) tMin = Math.min(tMin, tE);
    if (tW > 1e-4) tMin = Math.min(tMin, tW);
  }
  if (Math.abs(ry) > 1e-9) {
    const tN = (halfLat - dy) / ry;
    const tS = (-halfLat - dy) / ry;
    if (tN > 1e-4) tMin = Math.min(tMin, tN);
    if (tS > 1e-4) tMin = Math.min(tMin, tS);
  }

  if (!Number.isFinite(tMin) || tMin <= 0) return 30; // fallback

  // Convert degree-distance to meters using the cell's known cell size
  // dLat corresponds to cellMeters, so tMin/dLat * cellMeters = meters
  const distanceM = (tMin / spec.dLat) * spec.cellMeters;
  const raw = distanceM / Math.max(1, speedMps);

  // Round to nearest 5 s, clamp to 10–180 s
  return Math.max(10, Math.min(180, Math.round(raw / 5) * 5));
}
