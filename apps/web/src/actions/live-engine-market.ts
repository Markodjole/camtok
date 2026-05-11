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
import { MIN_MS_BETWEEN_SYSTEM_MARKETS } from "@/lib/live/liveBetMinOpenMs";
import { engineBetHeadline } from "@/lib/live/betting/betTypeV2Label";
import { metersBetween } from "@/lib/live/routing/geometry";

/**
 * Engine markets time-lock quickly so the viewer sees a new bet headline every
 * few seconds — the room then settles + opens a fresh market of a different
 * type. Real outcome data is still recorded against the lock-time snapshot.
 */
const ENGINE_OPEN_SEC = 5;
/** Reveal a beat after lock so tick can settle and roll into the next market. */
const ENGINE_REVEAL_AFTER_LOCK_MS = 1_000;
const ENGINE_ROTATION_ORDER: BetTypeV2[] = [
  "time_vs_google",
  "stop_count",
  "turn_count_to_pin",
  "turns_before_zone_exit",
  "zone_exit_time",
  "zone_duration",
  "eta_drift",
];

/**
 * Opens a provisional engine-bet market for the given room.
 * Picks the best eligible engine round plan from the betting engine,
 * creates a `live_betting_markets` row with provisional options, and
 * advances the room to `market_open`.
 */
export async function openEngineMarketForRoom(roomId: string) {
  unstable_noStore();

  /**
   * Engine eligibility used to gate market opening — but a single transient
   * failure in the betting engine snapshot (e.g. brief geocode hiccup) would
   * stall the entire cycle. We now treat eligibility as a *hint* only: if it
   * resolves we filter the rotation by it; if it errors we still open one of
   * the rotation defaults. The user's priority is "a new bet every few
   * seconds", so we never bail here on engine-snapshot errors.
   */
  const payload = await getActiveBettingRoundPayload(roomId, null);
  /** Reserved for telemetry / future gating — do not shrink rotation to this list. */
  const _eligibleHint =
    "error" in payload
      ? []
      : (payload.eligibleRoundPlans ?? [])
          .map((p) => p.type)
          .filter((t): t is BetTypeV2 => ENGINE_BET_TYPES.has(t));
  void _eligibleHint;

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

  // Always rotate the full engine lineup. Filtering by `eligibleRoundPlans`
  // left rooms stuck on time_vs_google + one or two other types whenever the
  // snapshot was conservative.
  const candidates = ENGINE_ROTATION_ORDER.filter((t) => ENGINE_BET_TYPES.has(t));
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
  // Never repeat the immediately-previous bet type — the viewer should always
  // see a different headline on each cycle.
  if (lastType && betType === lastType && candidates.length > 1) {
    betType =
      candidates.find((t) => t !== lastType) ?? betType;
  }

  const options = provisionalOptionsForBetType(
    betType as Parameters<typeof provisionalOptionsForBetType>[0],
  );
  if (!options.length) return { error: "No provisional options for this bet type" };

  const { data: prevMkt } = await service
    .from("live_betting_markets")
    .select("opens_at")
    .eq("room_id", roomId)
    .order("opens_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (prevMkt) {
    const nowMs = Date.now();
    const prevOpensMs = Date.parse((prevMkt as { opens_at: string }).opens_at);
    if (
      Number.isFinite(prevOpensMs) &&
      nowMs - prevOpensMs < MIN_MS_BETWEEN_SYSTEM_MARKETS
    ) {
      return { error: "Spacing: previous market too recent" };
    }
  }

  const title = engineBetHeadline(betType as Parameters<typeof engineBetHeadline>[0]);
  const relax = liveBetRelaxServer();
  const now = new Date();
  const locksAtMs = now.getTime() + (relax ? 3_600_000 : ENGINE_OPEN_SEC * 1_000);
  const locksAt = new Date(locksAtMs);
  const revealAt = new Date(locksAtMs + ENGINE_REVEAL_AFTER_LOCK_MS);

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
  // Engine markets are now short bet windows — settle ~1 s after they lock so
  // the room can roll into the next bet type quickly. Real outcomes for "did
  // the driver actually turn here" are still recorded against the lock-time
  // GPS snapshot during the lifetime of the snapshot.
  if (Date.now() - locksAtMs > 1_000) return true;

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
