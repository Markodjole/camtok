"use server";

import { unstable_noStore } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import type { LiveMarketOption } from "@bettok/live";
import { computeDriverRouteInstruction } from "@/lib/live/routing/computeDriverRouteInstruction";
import {
  analyzeStreakAhead,
  type CrossroadBearing,
  type StraightStreakSubtitle,
} from "@/lib/live/routing/straightStreakAnalyzer";
import {
  BET_OPEN_WINDOW_IDLE_MS,
  STRAIGHT_STREAK_MIN_LENGTH,
} from "@/lib/live/betting/betWindowConstants";
import { computeEqualOdds } from "@/lib/live/betting/marketOdds";

/**
 * `straight_streak`: Bet on how many consecutive straight-through
 * intersections the driver takes before making a turn.
 *
 * Market lifecycle
 * ────────────────
 * • Opens when ≥ STRAIGHT_STREAK_MIN_LENGTH consecutive "straight" crossroads
 *   are detected ahead on the planning polyline.
 * • Bets lock after BET_OPEN_WINDOW_IDLE_MS (12 s) — longer window than
 *   next_turn because there's no spatial urgency; the driver isn't about to
 *   pass the intersection in the next few seconds.
 * • Settlement is deferred (ENGINE_BET_TYPES) and triggered by the sweep
 *   once the driver's heading changes by ≥ STRAIGHT_STREAK_COMMITTED_TURN_DEG,
 *   or when reveal_at fires as a safety cap.
 *
 * Subtitle schema (stored as JSON, parsed by straightStreakResolver)
 * ──────────────────────────────────────────────────────────────────
 * {
 *   expectedStreak: number;          // N at open time
 *   streakKey: string;               // de-dupe key = "streak:<firstNodeId>"
 *   intersections: CrossroadBearing[]; // expected crossroads with bearings
 * }
 */

// Re-export for legacy imports (the canonical definition lives in the analyzer).
export type { CrossroadBearing, StraightStreakSubtitle };

/**
 * Open a `straight_streak` market for the given room.
 *
 * @param streakKey - If provided, skip the market if one with this key already
 *   exists recently (de-dupe from trigger).  Re-computed inside on opening.
 */
export async function openStraightStreakMarketForRoom(
  roomId: string,
  opts?: { windowMs?: number; streakKey?: string },
): Promise<{ marketId: string; betType: "straight_streak" } | { error: string }> {
  unstable_noStore();
  const service = await createServiceClient();

  // ── Load room + session ───────────────────────────────────────────────────
  const { data: room } = await service
    .from("live_rooms")
    .select("id, live_session_id, phase")
    .eq("id", roomId)
    .maybeSingle();
  if (!room) return { error: "room_not_found" };

  const sessionId = (room as { live_session_id: string | null }).live_session_id;
  if (!sessionId) return { error: "no_live_session" };

  const { data: session } = await service
    .from("character_live_sessions")
    .select("id, character_id")
    .eq("id", sessionId)
    .maybeSingle();
  if (!session) return { error: "session_not_found" };

  const characterId = (session as { character_id: string }).character_id;

  // ── Compute route + streak analysis ───────────────────────────────────────
  const drv = await computeDriverRouteInstruction(roomId);
  if (!drv.instruction || drv.instruction.pins.length < STRAIGHT_STREAK_MIN_LENGTH) {
    return { error: `straight_streak: only ${drv.instruction?.pins.length ?? 0} pin(s) — need ≥ ${STRAIGHT_STREAK_MIN_LENGTH}` };
  }

  const analysis = analyzeStreakAhead(drv.planningPolyline, drv.instruction.pins);

  if (!analysis.streakKey || analysis.streakLength < STRAIGHT_STREAK_MIN_LENGTH) {
    return {
      error: `straight_streak: streak length ${analysis.streakLength} < min ${STRAIGHT_STREAK_MIN_LENGTH}`,
    };
  }

  const { streakKey, streakLength: expectedStreak, crossroads } = analysis;

  // ── De-dupe: skip if this streak was already bet on recently ──────────────
  const { data: prior } = await service
    .from("live_betting_markets")
    .select("id, subtitle")
    .eq("room_id", roomId)
    .eq("market_type", "straight_streak")
    .order("opens_at", { ascending: false })
    .limit(10);

  const alreadyFired = (prior ?? []).some((row) => {
    try {
      const meta = JSON.parse(
        (row as { subtitle: string | null }).subtitle ?? "{}",
      ) as { streakKey?: string };
      return meta.streakKey === streakKey;
    } catch {
      return false;
    }
  });
  if (alreadyFired) {
    return { error: `straight_streak: streakKey ${streakKey} already bet` };
  }

  // ── Character name for title ───────────────────────────────────────────────
  const { data: characterRow } = await service
    .from("characters")
    .select("name")
    .eq("id", characterId)
    .maybeSingle();
  const characterName = (characterRow as { name: string } | null)?.name ?? "the driver";

  // ── Build options with real N ──────────────────────────────────────────────
  const options: LiveMarketOption[] = [
    {
      id: "streak_under",
      label: `Fewer than ${expectedStreak} straight in a row`,
      shortLabel: `< ${expectedStreak}`,
      displayOrder: 0,
    },
    {
      id: "streak_at",
      label: `About ${expectedStreak} straight in a row (±1)`,
      shortLabel: `= ${expectedStreak}`,
      displayOrder: 1,
    },
    {
      id: "streak_over",
      label: `More than ${expectedStreak} straight in a row`,
      shortLabel: `> ${expectedStreak}`,
      displayOrder: 2,
    },
  ];

  const odds = computeEqualOdds(options);

  const subtitle: StraightStreakSubtitle = {
    expectedStreak,
    streakKey,
    // Store only the crossroads in the streak (not the first non-straight one).
    intersections: crossroads.slice(0, expectedStreak),
  };

  // ── Timing ────────────────────────────────────────────────────────────────
  const now = new Date();
  const windowMs = opts?.windowMs ?? BET_OPEN_WINDOW_IDLE_MS;
  const locksAt = new Date(now.getTime() + windowMs);
  // Safety cap: give enough time for the driver to traverse all intersections.
  // Intersections are ~200–300 m apart; 35 s per intersection is conservative.
  const revealMs = Math.max(90_000, expectedStreak * 35_000);
  const revealAt = new Date(now.getTime() + revealMs);

  // ── Insert market ─────────────────────────────────────────────────────────
  const { data: market, error: marketError } = await service
    .from("live_betting_markets")
    .insert({
      room_id: roomId,
      live_session_id: sessionId,
      source: "system_generated",
      title: `How many straights does ${characterName} take in a row?`,
      subtitle: JSON.stringify(subtitle),
      market_type: "straight_streak",
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
    .eq("id", roomId);

  await service.from("live_room_events").insert({
    room_id: roomId,
    market_id: (market as { id: string }).id,
    event_type: "market_open",
    payload: {
      title: `How many straights does ${characterName} take in a row?`,
      optionCount: options.length,
      betType: "straight_streak",
      streakKey,
      expectedStreak,
    },
  });

  console.log(`[straight_streak] opened market ${(market as { id: string }).id}`, {
    roomId,
    streakKey,
    expectedStreak,
    intersectionCount: subtitle.intersections.length,
  });

  return { marketId: (market as { id: string }).id, betType: "straight_streak" };
}
