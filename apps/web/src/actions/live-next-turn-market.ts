"use server";

import { unstable_noStore } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { Safety, type LiveMarketOption, type TransportMode } from "@bettok/live";
import { computeDriverRouteInstruction } from "@/lib/live/routing/computeDriverRouteInstruction";
import {
  BET_OPEN_WINDOW_MS,
  NEXT_TURN_PIN_MAX_M,
  NEXT_TURN_PIN_MIN_M,
} from "@/lib/live/betting/betWindowConstants";

/**
 * `next_turn`: Left / Straight / Right bet at the next blue pin.
 *
 * Trigger rule (the only gate):
 *   Driver must be within [NEXT_TURN_PIN_MIN_M, NEXT_TURN_PIN_MAX_M] of the
 *   next pin (nominally 120 m ± 30 m = 90–150 m). Fires once per pin
 *   (per-pin dupe guard).
 */
/**
 * @param opts.queuedPinId  When the trigger was pre-validated in the queue,
 *   pass the pin OSM node id so we skip the 90 m lower-bound check — the
 *   driver may have moved closer since the trigger was queued but hasn't
 *   passed the intersection yet.
 */
export async function openNextTurnMarketForRoom(
  roomId: string,
  opts?: { queuedPinId?: number },
) {
  unstable_noStore();
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

  const { data: sessionRow } = await service
    .from("character_live_sessions")
    .select("transport_mode, character_id")
    .eq("id", sessionId)
    .maybeSingle();
  if (!sessionRow) return { error: "Session not found" };
  const transportMode = (sessionRow as { transport_mode: TransportMode }).transport_mode;
  const characterId = (sessionRow as { character_id: string }).character_id;

  const policy = Safety.policyFor(transportMode);
  if (!policy.allowSystemMarkets) {
    return { error: "System markets disabled for this mode" };
  }

  const drv = await computeDriverRouteInstruction(roomId);
  if (!drv.instruction || drv.instruction.pins.length === 0) {
    return {
      error: `next_turn: no pin (${drv.instruction ? "empty" : drv.reason})`,
    };
  }
  const pin = drv.instruction.pins[0]!;
  const dist = pin.distanceMeters;
  if (!Number.isFinite(dist)) {
    return { error: "next_turn: no pin distance" };
  }

  const isQueuedPin = opts?.queuedPinId != null && opts.queuedPinId === pin.id;
  if (isQueuedPin) {
    // Queued trigger: window was already validated. Only reject if the driver
    // has fully passed the pin (dist ≤ 0) or moved past the upper bound.
    if (dist <= 0 || dist > NEXT_TURN_PIN_MAX_M) {
      return {
        error: `next_turn: queued pin ${Math.round(dist)} m — driver already passed or too far`,
      };
    }
  } else if (dist < NEXT_TURN_PIN_MIN_M || dist > NEXT_TURN_PIN_MAX_M) {
    return {
      error: `next_turn: pin ${Math.round(dist)} m (need ${NEXT_TURN_PIN_MIN_M}–${NEXT_TURN_PIN_MAX_M} m)`,
    };
  }

  const pinKey = `pin:${pin.id}`;
  const { data: prior } = await service
    .from("live_betting_markets")
    .select("id, subtitle")
    .eq("room_id", roomId)
    .eq("market_type", "next_turn")
    .order("opens_at", { ascending: false })
    .limit(20);
  const alreadyFired = (prior ?? []).some((row) => {
    try {
      const meta = JSON.parse(
        (row as { subtitle: string | null }).subtitle ?? "{}",
      ) as { pinKey?: string };
      return meta.pinKey === pinKey;
    } catch {
      return false;
    }
  });
  if (alreadyFired) {
    return { error: `next_turn: pin ${pin.id} already bet` };
  }

  const { data: characterRow } = await service
    .from("characters")
    .select("name")
    .eq("id", characterId)
    .maybeSingle();
  const characterName = (characterRow as { name: string } | null)?.name ?? "character";

  const options: LiveMarketOption[] = [
    { id: "left", label: "Left", shortLabel: "Left", displayOrder: 0 },
    { id: "straight", label: "Straight", shortLabel: "Straight", displayOrder: 1 },
    { id: "right", label: "Right", shortLabel: "Right", displayOrder: 2 },
  ];

  const now = new Date();
  const locksAt = new Date(now.getTime() + BET_OPEN_WINDOW_MS);
  const revealAt = new Date(now.getTime() + 60_000);

  const { data: market, error: marketError } = await service
    .from("live_betting_markets")
    .insert({
      room_id: roomId,
      live_session_id: sessionId,
      decision_node_id: null,
      source: "system_generated",
      title: `Which way does ${characterName} go?`,
      subtitle: JSON.stringify({ pinKey, pinId: pin.id, openDistanceM: dist }),
      market_type: "next_turn",
      option_set: options,
      opens_at: now.toISOString(),
      locks_at: locksAt.toISOString(),
      reveal_at: revealAt.toISOString(),
      status: "open",
      turn_point_lat: pin.lat,
      turn_point_lng: pin.lng,
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
    payload: {
      title: `Which way does ${characterName} go?`,
      optionCount: options.length,
      marketKind: "next_turn",
      pinId: pin.id,
    },
  });

  return { marketId: market.id as string, pinId: pin.id, openDistanceM: dist };
}
