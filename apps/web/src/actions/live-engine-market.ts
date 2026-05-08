"use server";

import { unstable_noStore } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { getActiveBettingRoundPayload } from "@/lib/live/betting/activeRound";
import type { BetTypeV2 } from "@bettok/live";
import {
  ENGINE_BET_TYPES,
  provisionalOptionsForBetType,
} from "@/lib/live/betting/engineMarketOptions";
import { liveBetRelaxServer } from "@/lib/live/liveBetRelax";
import { engineBetHeadline } from "@/lib/live/betting/betTypeV2Label";
import { metersBetween } from "@/lib/live/routing/geometry";

/** Betting window for provisional engine markets (seconds). */
const ENGINE_OPEN_SEC = 120;
/**
 * Far-future placeholder for reveal_at on engine markets.
 * Actual reveal is event-driven (zone exit, turn, pin reached, etc.).
 * Using 2 hours so the time-based path in the tick route never fires accidentally.
 */
const ENGINE_REVEAL_FAR_FUTURE_MS = 2 * 60 * 60 * 1_000;
const ENGINE_ROTATION_ORDER: BetTypeV2[] = [
  "time_vs_google",
  "stop_count",
  "turn_count_to_pin",
  "turns_before_zone_exit",
  "zone_exit_time",
];

/**
 * Opens a provisional engine-bet market for the given room.
 * Picks the best eligible engine round plan from the betting engine,
 * creates a `live_betting_markets` row with provisional options, and
 * advances the room to `market_open`.
 */
export async function openEngineMarketForRoom(roomId: string) {
  unstable_noStore();

  const payload = await getActiveBettingRoundPayload(roomId, null);
  if ("error" in payload) return { error: payload.error };

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

  const eligibleEngineTypes = (payload.eligibleRoundPlans ?? [])
    .map((p) => p.type)
    .filter((t): t is BetTypeV2 => ENGINE_BET_TYPES.has(t));

  const { data: recentMarkets } = await service
    .from("live_betting_markets")
    .select("market_type, subtitle, opens_at")
    .eq("room_id", roomId)
    .order("opens_at", { ascending: false })
    .limit(12);

  const wasShownInCurrentZone = (marketType: string): boolean => {
    if (!capturedZone) return false;
    for (const m of recentMarkets ?? []) {
      const row = m as { market_type: string; subtitle: string | null };
      if (row.market_type !== marketType) continue;
      try {
        const meta = JSON.parse(row.subtitle ?? "{}") as { capturedZone?: string | null };
        if ((meta.capturedZone ?? null) === capturedZone) return true;
      } catch {
        /* ignore */
      }
    }
    return false;
  };

  const lastType =
    (recentMarkets?.[0] as { market_type?: string } | undefined)?.market_type ?? null;

  // Strong variety first: rotate through engine types so users see everything.
  const candidates = (eligibleEngineTypes.length
    ? ENGINE_ROTATION_ORDER.filter((t) => eligibleEngineTypes.includes(t))
    : ENGINE_ROTATION_ORDER
  ).filter((t) => ENGINE_BET_TYPES.has(t));
  if (!candidates.length) return { error: "No engine candidate" };

  const lastIdx = lastType ? candidates.indexOf(lastType as BetTypeV2) : -1;
  let betType = candidates[(lastIdx + 1 + candidates.length) % candidates.length]!;
  if (
    (betType === "turns_before_zone_exit" || betType === "stop_count") &&
    wasShownInCurrentZone(betType) &&
    candidates.length > 1
  ) {
    betType = candidates.find((t) => t !== betType) ?? betType;
  }

  const options = provisionalOptionsForBetType(
    betType as Parameters<typeof provisionalOptionsForBetType>[0],
  );
  if (!options.length) return { error: "No provisional options for this bet type" };

  // 6-second minimum spacing between markets (looser for demo activity).
  const { data: prevMkt } = await service
    .from("live_betting_markets")
    .select("opens_at, reveal_at")
    .eq("room_id", roomId)
    .order("opens_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (prevMkt) {
    const nowMs = Date.now();
    const prevRevealMs = (prevMkt as { reveal_at: string | null }).reveal_at
      ? Date.parse((prevMkt as { reveal_at: string }).reveal_at)
      : null;
    const prevOpensMs = Date.parse((prevMkt as { opens_at: string }).opens_at);
    const refMs = Number.isFinite(prevRevealMs as number) ? (prevRevealMs as number) : prevOpensMs;
    if (Number.isFinite(refMs) && nowMs - refMs < 6_000) {
      return { error: "Spacing: previous market too recent" };
    }
  }

  const title = engineBetHeadline(betType as Parameters<typeof engineBetHeadline>[0]);
  const relax = liveBetRelaxServer();
  const now = new Date();
  const locksAtMs = now.getTime() + (relax ? 3_600_000 : ENGINE_OPEN_SEC * 1_000);
  const locksAt = new Date(locksAtMs);
  // Reveal is event-driven, not time-based. Set far-future as a safety net.
  const revealAt = new Date(locksAtMs + ENGINE_REVEAL_FAR_FUTURE_MS);

  const { data: market, error: marketError } = await service
    .from("live_betting_markets")
    .insert({
      room_id: roomId,
      live_session_id: sessionId,
      source: "system_generated",
      title,
      // Subtitle stores metadata needed for event-driven settlement.
      subtitle: JSON.stringify({ capturedZone }),
      // market_type doubles as the engine bet-type identifier for settlement.
      market_type: betType,
      option_set: options,
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
 * Checks whether an engine market's natural settlement condition has been met.
 *
 * Each bet type is tied to a real-world event:
 *   - zone_exit_time / turns_before_zone_exit → driver left the captured zone
 *   - turn_count_to_pin                       → a new turn (decision node) was created after lock
 *   - time_vs_google                          → a new turn market opened after lock (driver reached next pin)
 *   - stop_count                              → driver traveled ≥ 400 m from their lock position
 *
 * Falls back to settling after 4 minutes of being locked if none of the
 * natural conditions fire (e.g. GPS data gap).
 */
export async function shouldSettleEngineMarket(
  service: Awaited<ReturnType<typeof createServiceClient>>,
  {
    marketId,
    marketType,
    locksAt,
    liveSessionId,
    roomId,
  }: {
    marketId: string;
    marketType: string;
    locksAt: string;
    liveSessionId: string | null;
    roomId: string;
  },
): Promise<boolean> {
  const locksAtMs = new Date(locksAt).getTime();
  // Hard upper-bound: settle after 4 minutes if the condition never fires.
  if (Date.now() - locksAtMs > 4 * 60 * 1_000) return true;

  switch (marketType) {
    case "zone_exit_time":
    case "turns_before_zone_exit": {
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
      // If we never had a zone, fall through to the 4-min fallback above.
      if (!capturedZone) return false;
      return currentZone !== capturedZone;
    }

    case "turn_count_to_pin": {
      // Settle when a new route_decision_node was created after the market locked —
      // meaning the driver reached and made a turn.
      if (!liveSessionId) return false;
      const { data: node } = await service
        .from("route_decision_nodes")
        .select("id")
        .eq("live_session_id", liveSessionId)
        .gt("created_at", locksAt)
        .limit(1)
        .maybeSingle();
      return !!node;
    }

    case "time_vs_google": {
      // Settle when a new system (non-engine) market opened after lock, indicating
      // the driver navigated past the next pin / decision point.
      const engineTypes = Array.from(ENGINE_BET_TYPES);
      const { data: newMarket } = await service
        .from("live_betting_markets")
        .select("id")
        .eq("room_id", roomId)
        .neq("id", marketId)
        .not("market_type", "in", `(${engineTypes.join(",")})`)
        .gt("opens_at", locksAt)
        .limit(1)
        .maybeSingle();
      return !!newMarket;
    }

    case "stop_count": {
      // Settle when driver has traveled ≥ 400 m from their lock-time position,
      // giving enough road time to count stops over a meaningful segment.
      if (!liveSessionId) return false;
      const { data: snapshots } = await service
        .from("live_route_snapshots")
        .select("normalized_lat,normalized_lng,raw_lat,raw_lng")
        .eq("live_session_id", liveSessionId)
        .gte("recorded_at", locksAt)
        .order("recorded_at", { ascending: true })
        .limit(60);
      if (!snapshots || snapshots.length < 2) return false;
      const first = snapshots[0] as {
        normalized_lat: number | null;
        normalized_lng: number | null;
        raw_lat: number;
        raw_lng: number;
      };
      const last = snapshots[snapshots.length - 1] as typeof first;
      const dist = metersBetween(
        {
          lat: first.normalized_lat ?? first.raw_lat,
          lng: first.normalized_lng ?? first.raw_lng,
        },
        {
          lat: last.normalized_lat ?? last.raw_lat,
          lng: last.normalized_lng ?? last.raw_lng,
        },
      );
      return dist >= 400;
    }

    default:
      return false;
  }
}
