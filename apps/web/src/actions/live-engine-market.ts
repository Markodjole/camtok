"use server";

import { unstable_noStore } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import type { BetTypeV2 } from "@bettok/live";
import { provisionalOptionsForBetType } from "@/lib/live/betting/engineMarketOptions";
import { metersBetween } from "@/lib/live/routing/geometry";
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

  const { data: room } = await service
    .from("live_rooms")
    .select("id, live_session_id, phase, region_label")
    .eq("id", roomId)
    .maybeSingle();
  if (!room) return { error: "Room not found" };
  if ((room as { phase: string }).phase !== "waiting_for_next_market") {
    return { error: "Room not in waiting phase" };
  }

  const sessionId = (room as { live_session_id: string }).live_session_id;
  const capturedZone = (room as { region_label: string | null }).region_label ?? null;

  const ctx = await loadGridCenterContext(service, sessionId, roomId);
  if (!ctx.ok) return { error: ctx.error };
  const { distanceM, cellKey, spec } = ctx;

  // Which phases have already fired for this cell in this session?
  const firedPhases = await loadFiredPhases(service, sessionId, cellKey);

  // Determine which phase to open — either the requested one or the next eligible.
  const candidatePhase = opts?.phase ?? pickEligiblePhase(distanceM, firedPhases);
  if (!candidatePhase) {
    return {
      error: `zone_exit_time: no eligible phase (dist=${Math.round(distanceM)} m, fired=${[...firedPhases].join(",")})`,
    };
  }

  // Verify the requested phase's gate condition is still met.
  const gateErr = checkPhaseGate(candidatePhase, distanceM, firedPhases);
  if (gateErr) return { error: gateErr };

  const betType: BetTypeV2 = "zone_exit_time";
  const options = provisionalOptionsForBetType(betType);
  if (!options.length) return { error: "No options for zone_exit_time" };

  const title =
    candidatePhase === "entry"
      ? "How long until driver leaves this zone?"
      : candidatePhase === "center_70m"
        ? "Driver near zone centre — how soon do they exit?"
        : "Driver heading out — will they leave the zone soon?";

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
      subtitle: JSON.stringify({ capturedZone, cellKey, triggerPhase: candidatePhase }),
      market_type: betType,
      option_set: options,
      city_grid_spec: spec as unknown as Record<string, unknown>,
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

  const [marketRow, roomRow] = await Promise.all([
    service
      .from("live_betting_markets")
      .select("subtitle")
      .eq("id", marketId)
      .maybeSingle(),
    service
      .from("live_rooms")
      .select("region_label")
      .eq("id", roomId)
      .maybeSingle(),
  ]);
  let capturedZone: string | null = null;
  try {
    const meta = JSON.parse(
      (marketRow.data as { subtitle: string | null } | null)?.subtitle ?? "{}",
    ) as { capturedZone?: string | null };
    capturedZone = meta.capturedZone ?? null;
  } catch {
    // ignore parse errors
  }
  const currentZone =
    (roomRow.data as { region_label: string | null } | null)?.region_label ?? null;
  if (!capturedZone) return false;
  return currentZone !== capturedZone;
}

// ─── Grid center helper ───────────────────────────────────────────────────────

async function loadGridCenterContext(
  service: Awaited<ReturnType<typeof createServiceClient>>,
  liveSessionId: string,
  roomId: string,
): Promise<
  | { ok: true; distanceM: number; cellId: string; cellKey: string; spec: CityGridSpecCompact }
  | { ok: false; error: string }
> {
  const { data: latestGps } = await service
    .from("live_route_snapshots")
    .select("normalized_lat,normalized_lng,raw_lat,raw_lng")
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
  return { ok: true, distanceM, cellId, cellKey, spec };
}
