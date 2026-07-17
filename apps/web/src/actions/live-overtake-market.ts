"use server";

import { unstable_noStore } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import type { LiveMarketOption } from "@bettok/live";
import { computeEqualOdds } from "@/lib/live/betting/marketOdds";
import {
  loadSingleMarketGate,
  singleMarketGateAllows,
} from "@/lib/live/betting/singleMarketGate";

export type Overtake30sSubtitle = {
  trackId: string;
  vehicleType: string;
  confidence: number;
  sameDirectionConfidence: number;
  relativeState: string;
  windowMs: number;
  openedAtMs: number;
};

const OVERTAKE_WINDOW_MS = 30_000;
const BET_LOCK_MS = 12_000;

/**
 * Yes/No: will the rider overtake the current lead vehicle within 30 seconds?
 *
 * Opens only when the room is waiting for a market and lead tracking is
 * prediction-ready. Settlement uses lead_vehicle_events (see overtake30sResolver).
 */
export async function openOvertake30sMarketForRoom(
  roomId: string,
  opts: {
    trackId: string;
    vehicleType: string;
    confidence: number;
    sameDirectionConfidence: number;
    relativeState: string;
    windowMs?: number;
  },
): Promise<{ marketId: string; betType: "overtake_30s" } | { error: string }> {
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

  // One bet at a time, 10s after the previous one closes — this action is
  // also reachable from telemetry ingest, so the gate lives here too.
  const gate = singleMarketGateAllows(
    await loadSingleMarketGate(service, sessionId),
  );
  if (!gate.allowed) {
    return {
      error: gate.code === "MARKET_ACTIVE" ? "market_active" : "close_gap",
    };
  }

  // De-dupe: one open overtake market per trackId per session.
  const { data: prior } = await service
    .from("live_betting_markets")
    .select("id, status, subtitle")
    .eq("live_session_id", sessionId)
    .eq("market_type", "overtake_30s")
    .in("status", ["open", "locked", "revealed"])
    .order("opens_at", { ascending: false })
    .limit(8);

  const already = (prior ?? []).some((row) => {
    try {
      const meta = JSON.parse(
        (row as { subtitle: string | null }).subtitle ?? "{}",
      ) as { trackId?: string };
      return meta.trackId === opts.trackId;
    } catch {
      return false;
    }
  });
  if (already) return { error: "overtake_already_open_for_track" };

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

  const vehicleLabel = opts.vehicleType.replace("_", " ");
  const options: LiveMarketOption[] = [
    {
      id: "overtake_yes",
      label: `Overtakes the ${vehicleLabel} within 30s`,
      shortLabel: "Yes ≤30s",
      displayOrder: 0,
    },
    {
      id: "overtake_no",
      label: `Does not overtake within 30s`,
      shortLabel: "No",
      displayOrder: 1,
    },
  ];
  const odds = computeEqualOdds(options);

  const now = new Date();
  const windowMs = opts.windowMs ?? OVERTAKE_WINDOW_MS;
  const locksAt = new Date(now.getTime() + BET_LOCK_MS);
  const revealAt = new Date(now.getTime() + windowMs + 5_000);

  const subtitle: Overtake30sSubtitle = {
    trackId: opts.trackId,
    vehicleType: opts.vehicleType,
    confidence: opts.confidence,
    sameDirectionConfidence: opts.sameDirectionConfidence,
    relativeState: opts.relativeState,
    windowMs,
    openedAtMs: now.getTime(),
  };

  const { data: market, error: marketError } = await service
    .from("live_betting_markets")
    .insert({
      room_id: roomId,
      live_session_id: sessionId,
      source: "system_generated",
      title: `Will ${characterName} overtake the lead ${vehicleLabel} in 30s?`,
      subtitle: JSON.stringify(subtitle),
      market_type: "overtake_30s",
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
      title: `Will ${characterName} overtake the lead ${vehicleLabel} in 30s?`,
      optionCount: options.length,
      betType: "overtake_30s",
      trackId: opts.trackId,
      vehicleType: opts.vehicleType,
    },
  });

  return { marketId: (market as { id: string }).id, betType: "overtake_30s" };
}
