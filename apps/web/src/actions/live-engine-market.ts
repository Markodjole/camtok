"use server";

import { unstable_noStore } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { getActiveBettingRoundPayload } from "@/lib/live/betting/activeRound";
import {
  ENGINE_BET_TYPES,
  provisionalOptionsForBetType,
} from "@/lib/live/betting/engineMarketOptions";
import { liveBetRelaxServer } from "@/lib/live/liveBetRelax";
import { engineBetHeadline } from "@/lib/live/betting/betTypeV2Label";

/** Betting window for provisional engine markets (seconds). */
const ENGINE_OPEN_SEC = 25;
/** Time between lock and reveal/settle (ms). */
const ENGINE_REVEAL_DELAY_MS = 8_000;

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

  const { roundPlan } = payload;
  if (!roundPlan) return { error: "No eligible round plan" };

  const betType = roundPlan.type;
  if (!ENGINE_BET_TYPES.has(betType)) {
    return { error: `${betType} is not an engine market type` };
  }

  const options = provisionalOptionsForBetType(betType as Parameters<typeof provisionalOptionsForBetType>[0]);
  if (!options.length) return { error: "No provisional options for this bet type" };

  const service = await createServiceClient();

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

  // 12-second minimum spacing between markets.
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
    if (Number.isFinite(refMs) && nowMs - refMs < 12_000) {
      return { error: "Spacing: previous market too recent" };
    }
  }

  const title = engineBetHeadline(betType as Parameters<typeof engineBetHeadline>[0]);
  const relax = liveBetRelaxServer();
  const now = new Date();
  const locksAtMs = now.getTime() + (relax ? 3_600_000 : ENGINE_OPEN_SEC * 1_000);
  const locksAt = new Date(locksAtMs);
  const revealAt = new Date(locksAtMs + ENGINE_REVEAL_DELAY_MS);

  const { data: market, error: marketError } = await service
    .from("live_betting_markets")
    .insert({
      room_id: roomId,
      live_session_id: sessionId,
      source: "system_generated",
      title,
      subtitle: null,
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
