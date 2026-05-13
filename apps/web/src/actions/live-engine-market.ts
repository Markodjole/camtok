"use server";

import { unstable_noStore } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import type { BetTypeV2 } from "@bettok/live";
import {
  provisionalOptionsForBetType,
} from "@/lib/live/betting/engineMarketOptions";
import { engineBetHeadline } from "@/lib/live/betting/betTypeV2Label";
import { metersBetween } from "@/lib/live/routing/geometry";
import {
  BET_OPEN_WINDOW_MS,
  ZONE_BET_CENTER_RADIUS_M,
} from "@/lib/live/betting/betWindowConstants";
import {
  cellIdForPosition,
  gridCellCenter,
  parseGridOptionId,
  type CityGridSpecCompact,
} from "@/lib/live/grid/cityGrid500";
import { getOrBuildGridSpecForRoom } from "@/lib/live/grid/gridSpecForRoom";
import { liveBetRelaxServer } from "@/lib/live/liveBetRelax";

/**
 * Active engine rotation. Other engine types still live in
 * `engineMarketOptions.ts` for future enablement, but only `zone_exit_time`
 * is offered today — the other six need real outcome wiring and are off until
 * that ships.
 */
const ENGINE_ROTATION_ORDER: BetTypeV2[] = ["zone_exit_time"];

/**
 * Opens a provisional engine-bet market for the given room.
 * Picks the best eligible engine round plan from the betting engine,
 * creates a `live_betting_markets` row with provisional options, and
 * advances the room to `market_open`.
 */
export async function openEngineMarketForRoom(roomId: string) {
  unstable_noStore();

  const service = await createServiceClient();

  const { data: room } = await service
    .from("live_rooms")
    .select("id, live_session_id, phase, region_label")
    .eq("id", roomId)
    .maybeSingle();
  if (!room) return { error: "Room not found" };
  const phaseStr = (room as { phase: string }).phase;
  if (phaseStr !== "waiting_for_next_market") {
    return { error: "Room not in waiting phase" };
  }

  const sessionId = (room as { live_session_id: string }).live_session_id;
  const capturedZone = (room as { region_label: string | null }).region_label ?? null;

  if (!ENGINE_ROTATION_ORDER.length) return { error: "No engine candidate" };
  const betType: BetTypeV2 = ENGINE_ROTATION_ORDER[0]!;

  /**
   * Zone-bet gating: only open when the driver is sitting close to the
   * center of their current grid cell (≤ ZONE_BET_CENTER_RADIUS_M = 100 m).
   * The radius check is bypassed in relax / dev mode so the rotation
   * always has a card to show; we still require the grid spec + GPS.
   */
  const relax = liveBetRelaxServer();
  let engineGridSpec: CityGridSpecCompact | null = null;
  if (betType === "zone_exit_time") {
    const ctx = await loadGridCenterContext(service, sessionId, roomId);
    if (!ctx.ok) return { error: ctx.error };
    if (!relax && ctx.distanceM > ZONE_BET_CENTER_RADIUS_M) {
      return {
        error: `zone_exit_time: ${Math.round(ctx.distanceM)} m from cell center > ${ZONE_BET_CENTER_RADIUS_M} m`,
      };
    }
    engineGridSpec = ctx.spec;
  }

  const options = provisionalOptionsForBetType(
    betType as Parameters<typeof provisionalOptionsForBetType>[0],
  );
  if (!options.length) return { error: "No provisional options for this bet type" };

  const title = engineBetHeadline(betType as Parameters<typeof engineBetHeadline>[0]);
  /**
   * Fixed 7-second open window. The tick force-locks the market when this
   * timestamp passes (or earlier if the viewer commits a bet). Settlement
   * is decoupled — `shouldSettleEngineMarket` watches the natural event
   * (e.g. driver leaves the captured zone for `zone_exit_time`) and the
   * grid market's parallel cell-cross detector handles `next_zone`.
   */
  const now = new Date();
  const locksAtMs = now.getTime() + BET_OPEN_WINDOW_MS;
  const locksAt = new Date(locksAtMs);
  // `reveal_at` is just the lifecycle safety timeout for settlement — keep
  // it generous (5 minutes) so the bet doesn't refund itself before the
  // driver actually leaves the zone.
  const revealAt = new Date(locksAtMs + 5 * 60_000);

  const { data: market, error: marketError } = await service
    .from("live_betting_markets")
    .insert({
      room_id: roomId,
      live_session_id: sessionId,
      source: "system_generated",
      title,
      subtitle: JSON.stringify({ capturedZone }),
      market_type: betType,
      option_set: options,
      /**
       * Persist the resolved grid spec on this row so subsequent zone bets
       * (either type) reuse it without round-tripping Google again.
       */
      city_grid_spec: engineGridSpec
        ? (engineGridSpec as unknown as Record<string, unknown>)
        : null,
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
    payload: { title, optionCount: options.length, betType },
  });

  return { marketId: market.id as string, betType };
}

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

  // Settle when driver has left the zone they were in when the market opened.
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

/**
 * Resolve the driver's distance from the center of their current grid cell.
 * Returns `{ ok: false, error }` whenever any prerequisite is missing
 * (no GPS, no recent `city_grid` market to source `cityGridSpec` from,
 * driver outside the grid bounds) so callers can skip cleanly.
 */
async function loadGridCenterContext(
  service: Awaited<ReturnType<typeof createServiceClient>>,
  liveSessionId: string,
  roomId: string,
): Promise<
  | { ok: true; distanceM: number; cellId: string; spec: CityGridSpecCompact }
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

  /**
   * Resolve the grid spec via the shared helper — reuses the spec from the
   * most recent `city_grid` market or builds one on the fly from Google.
   * Without this fallback `zone_exit_time` could not open before the very
   * first `next_zone` had opened (chicken-and-egg) and the user reported
   * the bet never showing.
   */
  const specRes = await getOrBuildGridSpecForRoom(service, roomId, liveSessionId);
  if (!specRes.ok) return { ok: false, error: specRes.error };
  const spec = specRes.spec;

  const cellId = cellIdForPosition(spec, lat, lng);
  if (!cellId) return { ok: false, error: "Zone gate: driver outside grid" };

  const parsed = parseGridOptionId(cellId);
  if (!parsed) return { ok: false, error: "Zone gate: bad cell id" };

  const center = gridCellCenter(spec, parsed.row, parsed.col);
  const distanceM = metersBetween({ lat, lng }, center);
  return { ok: true, distanceM, cellId, spec };
}
