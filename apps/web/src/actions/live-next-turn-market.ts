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
import { liveBetRelaxServer } from "@/lib/live/liveBetRelax";

/**
 * Open a directional "Left / Straight / Right" market gated on the **next
 * blue pin distance** — only when the driver is `NEXT_TURN_PIN_MIN_M ≤ d ≤
 * NEXT_TURN_PIN_MAX_M` from the pin (~150 m ±20 m).
 *
 * One market per pin per room: as soon as a market for the same pin id has
 * been opened we skip until the driver moves on to the next pin.
 *
 * Settlement is handled by `revealAndSettleMarket` in `live-settlement.ts`,
 * which compares the committed GPS path against the option directions.
 */
export async function openNextTurnMarketForRoom(roomId: string) {
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
  const transportMode = (sessionRow as { transport_mode: TransportMode })
    .transport_mode;
  const characterId = (sessionRow as { character_id: string }).character_id;

  const policy = Safety.policyFor(transportMode);
  if (!policy.allowSystemMarkets) {
    return { error: "System markets disabled for this mode" };
  }

  const drv = await computeDriverRouteInstruction(roomId);
  if (!drv.instruction || drv.instruction.pins.length === 0) {
    return { error: `next_turn: no pin (${drv.instruction ? "empty" : drv.reason})` };
  }
  const pin = drv.instruction.pins[0]!;
  const dist = pin.distanceMeters;
  if (!Number.isFinite(dist)) {
    return { error: "next_turn: no pin distance" };
  }
  /**
   * Hard gate at 150 m ±20 m. We open exactly once while the driver is
   * inside the window — the per-pin lookup below prevents reopen on the
   * same pin if they hover. Both gates are bypassed in relax / dev mode so
   * the bet card actually shows up at any pin distance.
   */
  const relax = liveBetRelaxServer();
  if (!relax && (dist < NEXT_TURN_PIN_MIN_M || dist > NEXT_TURN_PIN_MAX_M)) {
    return {
      error: `next_turn: pin ${Math.round(dist)} m (need ${NEXT_TURN_PIN_MIN_M}\u2013${NEXT_TURN_PIN_MAX_M} m)`,
    };
  }

  const pinKey = `pin:${pin.id}`;
  if (!relax) {
    const { data: prior } = await service
      .from("live_betting_markets")
      .select("id, subtitle")
      .eq("room_id", roomId)
      .eq("market_type", "next_turn")
      .order("opens_at", { ascending: false })
      .limit(8);
    const dupe = (prior ?? []).some((row) => {
      try {
        const meta = JSON.parse(
          (row as { subtitle: string | null }).subtitle ?? "{}",
        ) as { pinKey?: string };
        return meta.pinKey === pinKey;
      } catch {
        return false;
      }
    });
    if (dupe) {
      return { error: `next_turn: pin ${pin.id} already bet` };
    }
  }

  const { data: characterRow } = await service
    .from("characters")
    .select("name")
    .eq("id", characterId)
    .maybeSingle();
  const characterName =
    (characterRow as { name: string } | null)?.name ?? "character";

  const options: LiveMarketOption[] = [
    { id: "left", label: "Left", shortLabel: "Left", displayOrder: 0 },
    { id: "straight", label: "Straight", shortLabel: "Straight", displayOrder: 1 },
    { id: "right", label: "Right", shortLabel: "Right", displayOrder: 2 },
  ];

  const now = new Date();
  const locksAt = new Date(now.getTime() + BET_OPEN_WINDOW_MS);
  /**
   * The driver typically reaches the pin within ~10 s once they're at 150 m
   * (depending on speed). Leave a generous reveal window so the path-based
   * settlement (`RouteState.revealFromMovement`) has enough committed GPS
   * to decide left/straight/right.
   */
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
