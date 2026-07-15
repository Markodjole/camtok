"use server";

import { unstable_noStore } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import type { LiveMarketOption } from "@bettok/live";
import { computeEqualOdds } from "@/lib/live/betting/marketOdds";
import { VEHICLE_COUNT_ROUND_MS } from "@/lib/live/vehicle-count/constants";

export type VehicleCount30sSubtitle = {
  roundId: string;
  countWindowMs: number;
  betLockMs: number;
  openedAtMs: number;
};

const BET_LOCK_MS = 12_000;

/**
 * Rush Hour–style: bet window, then count vehicles crossing the camera zone for 30s.
 */
export async function openVehicleCount30sMarketForRoom(
  roomId: string,
): Promise<{ marketId: string; betType: "vehicle_count_30s" } | { error: string }> {
  unstable_noStore();
  const service = await createServiceClient();

  const { data: room } = await service
    .from("live_rooms")
    .select("id, live_session_id, phase")
    .eq("id", roomId)
    .maybeSingle();
  if (!room) return { error: "room_not_found" };
  if ((room as { phase: string }).phase !== "waiting_for_next_market") {
    return { error: "room_not_waiting" };
  }

  const sessionId = (room as { live_session_id: string | null }).live_session_id;
  if (!sessionId) return { error: "no_live_session" };

  const { data: prior } = await service
    .from("live_betting_markets")
    .select("id")
    .eq("live_session_id", sessionId)
    .eq("market_type", "vehicle_count_30s")
    .in("status", ["open", "locked", "revealed"])
    .limit(1)
    .maybeSingle();
  if (prior) return { error: "vehicle_count_round_already_open" };

  const { data: session } = await service
    .from("character_live_sessions")
    .select("character_id")
    .eq("id", sessionId)
    .maybeSingle();
  const characterId = (session as { character_id: string } | null)?.character_id;
  const { data: characterRow } = characterId
    ? await service.from("characters").select("name").eq("id", characterId).maybeSingle()
    : { data: null };
  const characterName =
    (characterRow as { name: string } | null)?.name ?? "the rider";

  const options: LiveMarketOption[] = [
    {
      id: "count_under_2",
      label: "Fewer than 2 vehicles",
      shortLabel: "< 2",
      displayOrder: 0,
    },
    {
      id: "count_2_to_4",
      label: "2 to 4 vehicles",
      shortLabel: "2–4",
      displayOrder: 1,
    },
    {
      id: "count_over_4",
      label: "More than 4 vehicles",
      shortLabel: "> 4",
      displayOrder: 2,
    },
  ];
  const odds = computeEqualOdds(options);

  const now = new Date();
  const roundId = crypto.randomUUID();
  const locksAt = new Date(now.getTime() + BET_LOCK_MS);
  const revealAt = new Date(locksAt.getTime() + VEHICLE_COUNT_ROUND_MS);

  const subtitle: VehicleCount30sSubtitle = {
    roundId,
    countWindowMs: VEHICLE_COUNT_ROUND_MS,
    betLockMs: BET_LOCK_MS,
    openedAtMs: now.getTime(),
  };

  const { data: market, error: marketError } = await service
    .from("live_betting_markets")
    .insert({
      room_id: roomId,
      live_session_id: sessionId,
      source: "system_generated",
      title: `How many vehicles pass ${characterName} in 30 seconds?`,
      subtitle: JSON.stringify(subtitle),
      market_type: "vehicle_count_30s",
      option_set: options,
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
      current_market_id: (market as { id: string }).id,
      last_event_at: now.toISOString(),
    })
    .eq("id", roomId)
    .eq("phase", "waiting_for_next_market");

  await service.from("live_room_events").insert({
    room_id: roomId,
    market_id: (market as { id: string }).id,
    event_type: "market_open",
    payload: {
      title: `How many vehicles pass ${characterName} in 30 seconds?`,
      optionCount: options.length,
      betType: "vehicle_count_30s",
      roundId,
    },
  });

  return { marketId: (market as { id: string }).id, betType: "vehicle_count_30s" };
}
