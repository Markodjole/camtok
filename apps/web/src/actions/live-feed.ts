"use server";

import { unstable_noStore } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import type { CityGridSpecCompact } from "@/lib/live/grid/cityGrid500";
import type { DrivingRouteStyle } from "@/lib/live/routing/drivingRouteStyle";
import { normalizeDrivingRouteStyle } from "@/lib/live/routing/drivingRouteStyle";
import type { MarketOdds } from "@/lib/live/betting/marketOdds";

export type RoutePoint = {
  lat: number;
  lng: number;
  /** compass heading, degrees (0 = north) */
  heading?: number;
  /** movement speed, m/s (streamer’s device only when available) */
  speedMps?: number;
  /** Device/server snapshot time (viewers — used for motion smoothing) */
  recordedAt?: string;
};

export type LiveMarketSlot = {
  id: string;
  title: string;
  marketType: string;
  /** When the current market row became open — used for min betting window. */
  opensAt: string;
  locksAt: string;
  revealAt: string;
  options: Array<{ id: string; label: string; shortLabel?: string; displayOrder: number }>;
  participantCount: number;
  turnPointLat: number | null;
  turnPointLng: number | null;
  /** Present when `marketType === "city_grid"` — compact grid spec (no per-cell list on the wire). */
  cityGridSpec: CityGridSpecCompact | null;
  /**
   * Decimal odds computed at market-open time (equal probability with 5 % margin).
   * Shape: { format: "decimal", margin: 0.05, lines: { optionId: 2.86 } }
   */
  odds: MarketOdds | null;
  /**
   * Parsed market subtitle JSON — carries per-market metadata.
   * For zone_exit_time: { estimatedSec: number, cellKey, triggerPhase, ... }
   */
  meta: Record<string, unknown> | null;
};

export type LiveFeedRow = {
  roomId: string;
  liveSessionId: string;
  characterId: string;
  characterName: string;
  characterSlug: string | null;
  characterTagline: string | null;
  transportMode: string;
  statusText: string | null;
  intentLabel: string | null;
  regionLabel: string | null;
  placeType: string | null;
  phase: string;
  viewerCount: number;
  participantCount: number;
  currentMarket: LiveMarketSlot | null;
  /** Independent step-slot market (next_step: pin / camera bets). Runs concurrently with currentMarket. */
  currentStepMarket: LiveMarketSlot | null;
  sessionStartedAt: string;
  lastHeartbeatAt: string | null;
  routePoints: RoutePoint[];
  destination: {
    lat: number;
    lng: number;
    label: string;
    placeId: string | null;
  } | null;
  /** Character routing persona — badges + Google/OSRM tuning. */
  drivingRouteStyle: DrivingRouteStyle;
};

type MarketOptions = NonNullable<LiveFeedRow["currentMarket"]>["options"];

/** Parse a JSON option_set field from the view (may be string or array). */
function parseMarketOptions(raw: unknown): MarketOptions {
  let v: unknown = raw;
  if (typeof raw === "string") {
    try { v = JSON.parse(raw) as unknown; } catch { return []; }
  }
  if (!Array.isArray(v)) return [];
  return v as MarketOptions;
}

/** Build a LiveMarketSlot from view columns, given a column prefix (e.g. "current_market_" or "current_step_market_"). */
function buildMarketSlot(r: Record<string, unknown>, prefix: string): LiveMarketSlot | null {
  const id = r[`${prefix}id`] as string | null;
  if (!id) return null;
  const mType = (r[`${prefix}type`] as string) ?? "";
  const options = parseMarketOptions(r[`${prefix}options`]);
  return {
    id,
    title: (r[`${prefix}title`] as string) ?? "",
    marketType: mType,
    opensAt: (r[`${prefix}opens_at`] as string) ?? "",
    locksAt: (r[`${prefix}locks_at`] as string) ?? "",
    revealAt: (r[`${prefix}reveal_at`] as string) ?? "",
    options: mType === "city_grid" ? [] : options,
    participantCount: (r[`${prefix}participants`] as number) ?? 0,
    turnPointLat: (r[`${prefix}turn_point_lat`] as number | null) ?? null,
    turnPointLng: (r[`${prefix}turn_point_lng`] as number | null) ?? null,
    cityGridSpec:
      mType === "city_grid" || mType === "zone_exit_time"
        ? ((r[`${prefix}city_grid_spec`] as CityGridSpecCompact | null) ?? null)
        : null,
    odds: (r[`${prefix}odds`] as MarketOdds | null) ?? null,
    meta: (() => {
      try {
        const s = r[`${prefix}subtitle`] as string | null;
        return s ? (JSON.parse(s) as Record<string, unknown>) : null;
      } catch { return null; }
    })(),
  };
}

/** Map one `active_live_rooms` row — shared by feed list and single-room detail. */
function liveFeedRowFromActiveRoomRow(r: Record<string, unknown>): LiveFeedRow {
  return {
    roomId: r.room_id as string,
    liveSessionId: r.live_session_id as string,
    characterId: r.character_id as string,
    characterName: r.character_name as string,
    characterSlug: (r.character_slug as string | null) ?? null,
    characterTagline: (r.character_tagline as string | null) ?? null,
    transportMode: r.transport_mode as string,
    statusText: (r.current_status_text as string | null) ?? null,
    intentLabel: (r.current_intent_label as string | null) ?? null,
    regionLabel: (r.region_label as string | null) ?? null,
    placeType: (r.place_type as string | null) ?? null,
    phase: r.phase as string,
    viewerCount: (r.viewer_count as number) ?? 0,
    participantCount: (r.participant_count as number) ?? 0,
    currentMarket: buildMarketSlot(r, "current_market_"),
    currentStepMarket: buildMarketSlot(r, "current_step_market_"),
    sessionStartedAt: r.session_started_at as string,
    lastHeartbeatAt: (r.last_heartbeat_at as string | null) ?? null,
    routePoints: [],
    destination:
      r.destination_lat != null && r.destination_lng != null
        ? {
            lat: r.destination_lat as number,
            lng: r.destination_lng as number,
            label:
              ((r.destination_label as string | null) ?? "").trim() ||
              "Destination",
            placeId: (r.destination_place_id as string | null) ?? null,
          }
        : null,
    drivingRouteStyle: normalizeDrivingRouteStyle(r.character_driving_route_style),
  };
}

export async function getLiveFeed(): Promise<{ items: LiveFeedRow[] }> {
  unstable_noStore();
  const service = await createServiceClient();

  const { data } = await service
    .from("active_live_rooms")
    .select("*")
    .limit(50);

  const items: LiveFeedRow[] = (data ?? []).map((r) =>
    liveFeedRowFromActiveRoomRow(r as Record<string, unknown>),
  );

  return { items };
}

export async function getLiveRoomDetail(roomId: string): Promise<{
  room: LiveFeedRow | null;
}> {
  unstable_noStore();
  const service = await createServiceClient();

  const { data } = await service
    .from("active_live_rooms")
    .select("*")
    .eq("room_id", roomId)
    .maybeSingle();

  if (!data) return { room: null };

  const base = liveFeedRowFromActiveRoomRow(data as Record<string, unknown>);

  // Fetch the last 100 GPS points for the map.
  const sessionId = data.live_session_id as string;
  const { data: snapshots } = await service
    .from("live_route_snapshots")
    .select(
      "normalized_lat,normalized_lng,raw_lat,raw_lng,heading_deg,speed_mps,recorded_at",
    )
    .eq("live_session_id", sessionId)
    .order("recorded_at", { ascending: false })
    .limit(100);

  const routePoints: RoutePoint[] = ((snapshots ?? []) as Array<{
    normalized_lat: number | null;
    normalized_lng: number | null;
    raw_lat: number;
    raw_lng: number;
    heading_deg: number | null;
    speed_mps: number | null;
    recorded_at: string;
  }>)
    .map((s) => ({
      lat: s.normalized_lat ?? s.raw_lat,
      lng: s.normalized_lng ?? s.raw_lng,
      heading: s.heading_deg ?? undefined,
      speedMps: s.speed_mps != null ? Number(s.speed_mps) : undefined,
      recordedAt: s.recorded_at,
    }))
    .reverse(); // oldest→newest for path drawing

  return { room: { ...base, routePoints } };
}
