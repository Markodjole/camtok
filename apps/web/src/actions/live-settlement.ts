"use server";

import { unstable_noStore } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { Markets, RouteState, type LiveMarketOption } from "@bettok/live";
import { resolveMarket, type MarketForResolution } from "@/lib/live/market-resolvers";

type LockEvidence = {
  currentNodeId: string;
  candidateOptionIds: string[];
  selectedOptionId: string;
  normalizedSnapshotTs: string;
  etaToDecisionSeconds: number | null;
  confidence: number;
};

async function recordDecisionAuditLock(
  service: Awaited<ReturnType<typeof createServiceClient>>,
  args: {
    liveSessionId: string;
    marketId: string;
    decisionNodeId: string | null;
    routeSnapshotId: string | null;
    commitHash: string;
    evidence: LockEvidence;
  },
) {
  const { data: session } = await service
    .from("character_live_sessions")
    .select("character_id")
    .eq("id", args.liveSessionId)
    .maybeSingle();
  const characterId = (session as { character_id?: string } | null)?.character_id;
  if (!characterId) return;
  await service.from("character_decision_audit_log").insert({
    character_id: characterId,
    live_session_id: args.liveSessionId,
    market_id: args.marketId,
    decision_node_id: args.decisionNodeId,
    route_snapshot_id: args.routeSnapshotId,
    lock_timestamp: new Date().toISOString(),
    commit_hash: args.commitHash,
    gps_confidence_score: args.evidence.confidence,
    evidence_json: args.evidence as unknown as Record<string, unknown>,
  });
}

async function finalizeDecisionAudit(
  service: Awaited<ReturnType<typeof createServiceClient>>,
  marketId: string,
  args: { anomalyFlags?: string[]; operatorIntervention?: boolean },
) {
  await service
    .from("character_decision_audit_log")
    .update({
      reveal_timestamp: new Date().toISOString(),
      anomaly_flags: args.anomalyFlags ?? [],
      operator_intervention_flag: args.operatorIntervention ?? false,
    })
    .eq("market_id", marketId);
}

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}

async function applyBehaviorLearningNudges(
  service: Awaited<ReturnType<typeof createServiceClient>>,
  args: {
    characterId: string;
    winningOptionId: string;
    reason: string;
    settledAt: string;
  },
) {
  const { data: current } = await service
    .from("character_behavior_profiles")
    .select(
      "risk_level_score, prefers_main_roads_score, speed_style_score, hesitation_tendency_score, safest_route_bias_score, exploration_bias_score, history_window_size",
    )
    .eq("character_id", args.characterId)
    .maybeSingle();

  const cur = (current ?? {}) as {
    risk_level_score?: number | null;
    prefers_main_roads_score?: number | null;
    speed_style_score?: number | null;
    hesitation_tendency_score?: number | null;
    safest_route_bias_score?: number | null;
    exploration_bias_score?: number | null;
    history_window_size?: number | null;
  };

  let risk = cur.risk_level_score ?? 0.5;
  let mainRoad = cur.prefers_main_roads_score ?? 0.5;
  let speed = cur.speed_style_score ?? 0.5;
  let hesitation = cur.hesitation_tendency_score ?? 0.5;
  let safeBias = cur.safest_route_bias_score ?? 0.5;
  let explore = cur.exploration_bias_score ?? 0.5;

  const id = args.winningOptionId.toLowerCase();
  const reason = args.reason.toLowerCase();
  const delta = 0.03;

  if (id.includes("left") || id.includes("right") || id.includes("turn")) {
    explore += delta;
    safeBias -= delta * 0.7;
    mainRoad -= delta * 0.5;
  }
  if (id.includes("continue") || id.includes("straight")) {
    safeBias += delta;
    mainRoad += delta * 0.6;
    explore -= delta * 0.6;
  }
  if (id.includes("stop") || id.includes("wait")) {
    hesitation += delta;
    speed -= delta;
    risk -= delta * 0.7;
  }
  if (reason.includes("low_confidence") || reason.includes("ambiguous")) {
    hesitation += delta * 0.8;
  }
  if (reason.includes("high_confidence")) {
    hesitation -= delta * 0.5;
  }

  await service.from("character_behavior_profiles").upsert(
    {
      character_id: args.characterId,
      risk_level_score: clamp01(risk),
      prefers_main_roads_score: clamp01(mainRoad),
      speed_style_score: clamp01(speed),
      hesitation_tendency_score: clamp01(hesitation),
      safest_route_bias_score: clamp01(safeBias),
      exploration_bias_score: clamp01(explore),
      history_window_size: cur.history_window_size ?? 50,
      learned_model_version: "v1-outcome-nudges",
      updated_at: args.settledAt,
    },
    { onConflict: "character_id" },
  );
}

/**
 * Locks an open market: snapshots the current route state, selects a
 * candidate outcome internally for evidence, and records an immutable
 * commit hash. Users' bets cannot change after this point.
 */
export async function lockMarket(marketId: string) {
  unstable_noStore();
  const service = await createServiceClient();

  const { data: market } = await service
    .from("live_betting_markets")
    .select(
      "id, room_id, live_session_id, status, option_set, decision_node_id, locks_at, market_type, city_grid_spec",
    )
    .eq("id", marketId)
    .maybeSingle();
  if (!market) return { error: "Market not found" };
  if ((market as { status: string }).status !== "open") {
    return { error: "Market not open" };
  }

  const { data: snapshot } = await service
    .from("live_route_snapshots")
    .select(
      "id, recorded_at, normalized_lat, normalized_lng, raw_lat, raw_lng, speed_mps, heading_deg, confidence_score",
    )
    .eq("live_session_id", (market as { live_session_id: string }).live_session_id)
    .order("recorded_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const options = (market as { option_set: LiveMarketOption[] }).option_set;

  /**
   * `selected` is the system's provisional "best guess" outcome stored on
   * the lock record for audit / commit-hash purposes. The real winner is
   * resolved later in `revealAndSettleMarket`. For all three active bet
   * types (`next_turn`, `next_zone`, `zone_exit_time`) the option set is
   * small and bounded; using the first option as the placeholder is fine.
   */
  const selected = options[0]?.id ?? "unknown";

  const candidateOptionIds = options.map((o) => o.id);

  const evidence: LockEvidence = {
    currentNodeId: (snapshot as { id: string } | null)?.id ?? "no_snapshot",
    candidateOptionIds,
    selectedOptionId: selected,
    normalizedSnapshotTs:
      (snapshot as { recorded_at: string } | null)?.recorded_at ??
      new Date().toISOString(),
    etaToDecisionSeconds: null,
    confidence: (snapshot as { confidence_score: number } | null)?.confidence_score ?? 0,
  };
  const commitHash = RouteState.computeCommitHash(evidence);

  await service.from("market_lock_records").insert({
    market_id: marketId,
    selected_option_id: selected,
    candidate_option_ids: candidateOptionIds,
    route_snapshot_id: (snapshot as { id: string } | null)?.id ?? null,
    decision_node_id: (market as { decision_node_id: string | null }).decision_node_id,
    commit_hash: commitHash,
    evidence_json: evidence as unknown as Record<string, unknown>,
  });

  await service
    .from("live_betting_markets")
    .update({
      status: "locked",
      lock_commit_hash: commitHash,
      lock_evidence_json: evidence as unknown as Record<string, unknown>,
    })
    .eq("id", marketId);

  await recordDecisionAuditLock(service, {
    liveSessionId: (market as { live_session_id: string }).live_session_id,
    marketId,
    decisionNodeId: (market as { decision_node_id: string | null }).decision_node_id,
    routeSnapshotId: (snapshot as { id: string } | null)?.id ?? null,
    commitHash,
    evidence,
  });

  // next_step markets run in their own independent slot (current_step_market_id)
  // and must NOT block the main slot by flipping the global room phase.
  // All other market types still set market_locked so the main slot freezes.
  const mType = (market as { market_type: string }).market_type;
  if (mType !== "next_step") {
    await service
      .from("live_rooms")
      .update({ phase: "market_locked", last_event_at: new Date().toISOString() })
      .eq("id", (market as { room_id: string }).room_id);
  }

  await service
    .from("live_bets")
    .update({ status: "locked" })
    .eq("market_id", marketId)
    .eq("status", "active");

  await service.from("live_room_events").insert({
    room_id: (market as { room_id: string }).room_id,
    market_id: marketId,
    event_type: "market_locked",
    payload: { commitHash },
  });

  return { commitHash };
}

/**
 * Atomically lock a market and settle it in one tick.
 *
 * Keeps `current_market_id` on the room throughout — the pointer is only
 * cleared by `settleMarketWithWinner` / `refundMarket` after payout is
 * written, so viewers never see a gap where there is no active market.
 *
 * This replaces the previous two-tick pattern of `lockMarket` (tick N)
 * followed by `revealAndSettleMarket` (tick N+1).
 */
export async function lockAndSettleMarket(marketId: string) {
  const lockResult = await lockMarket(marketId);
  if ("error" in lockResult) return lockResult;
  return revealAndSettleMarket(marketId);
}

/**
 * Determine the winner for a locked market and pay out all bets.
 *
 * Delegates winner resolution to the market-resolver registry so each bet
 * type has an isolated, testable resolver function. See
 * `src/lib/live/market-resolvers/` for the per-type implementations.
 */
export async function revealAndSettleMarket(marketId: string) {
  unstable_noStore();
  const service = await createServiceClient();

  const { data: market } = await service
    .from("live_betting_markets")
    .select("id, room_id, live_session_id, status, option_set, decision_node_id, opens_at, reveal_at, market_type, city_grid_spec, subtitle, turn_point_lat, turn_point_lng")
    .eq("id", marketId)
    .maybeSingle();

  if (!market) return { error: "Market not found" };
  if ((market as unknown as { status: string }).status !== "locked") {
    return { error: "Market not locked" };
  }

  const m = market as unknown as {
    id: string;
    room_id: string;
    live_session_id: string;
    status: string;
    option_set: LiveMarketOption[];
    decision_node_id: string | null;
    opens_at: string;
    reveal_at: string;
    market_type: string;
    city_grid_spec: unknown;
    subtitle: string | null;
    turn_point_lat: number | null;
    turn_point_lng: number | null;
  };

  const marketData: MarketForResolution = {
    id: m.id,
    room_id: m.room_id,
    live_session_id: m.live_session_id,
    market_type: m.market_type ?? "",
    option_set: m.option_set ?? [],
    opens_at: m.opens_at,
    reveal_at: m.reveal_at,
    city_grid_spec: (m.city_grid_spec ?? null) as MarketForResolution["city_grid_spec"],
    subtitle: m.subtitle,
    turn_point_lat: m.turn_point_lat,
    turn_point_lng: m.turn_point_lng,
    decision_node_id: m.decision_node_id,
  };

  const resolution = await resolveMarket(marketData, service);

  if (resolution.outcome === "refund") {
    await refundMarket(marketId, resolution.reason);
    return { status: "refund" as const, reason: resolution.reason };
  }

  return settleMarketWithWinner(marketId, resolution.optionId, resolution.reason);
}

async function refundMarket(marketId: string, reason: string) {
  const service = await createServiceClient();
  const { data: bets } = await service
    .from("live_bets")
    .select("id, user_id, stake_amount, status")
    .eq("market_id", marketId)
    .in("status", ["locked", "active"]);

  for (const b of bets ?? []) {
    const userId = b.user_id as string;
    const stake = b.stake_amount as number;
    const { data: wallet } = await service
      .from("wallets")
      .select("balance_demo")
      .eq("user_id", userId)
      .maybeSingle();
    const newBal = ((wallet as { balance_demo: number } | null)?.balance_demo ?? 0) + stake;
    await service.from("wallets").update({ balance_demo: newBal }).eq("user_id", userId);
    await service
      .from("live_bets")
      .update({
        status: "refunded",
        settled_at: new Date().toISOString(),
        won: null,
        payout_amount: stake,
      })
      .eq("id", b.id as string);
  }

  await service
    .from("live_betting_markets")
    .update({ status: "cancelled", settlement_reason: reason })
    .eq("id", marketId);

  const { data: market } = await service
    .from("live_betting_markets")
    .select("room_id, live_session_id")
    .eq("id", marketId)
    .maybeSingle();
  if (market) {
    const rid = (market as { room_id: string }).room_id;
    await service.from("live_room_events").insert({
      room_id: rid,
      market_id: marketId,
      event_type: "market_cancelled",
      payload: { reason },
    });
    /**
     * Only reset the room's phase / current_market_id when we just refunded
     * the market that IS the room's current market. Settlements now run in
     * a background sweep against orphaned locked markets, so clearing the
     * pointer unconditionally would knock the currently-visible bet off the
     * viewer screen mid-window.
     */
    const { data: roomNow } = await service
      .from("live_rooms")
      .select("current_market_id, current_step_market_id")
      .eq("id", rid)
      .maybeSingle();
    const rn = roomNow as { current_market_id: string | null; current_step_market_id: string | null } | null;
    if (rn?.current_market_id === marketId) {
      await service.from("live_rooms").update({
        phase: "waiting_for_next_market",
        current_market_id: null,
      }).eq("id", rid);
    } else if (rn?.current_step_market_id === marketId) {
      await service.from("live_rooms").update({
        current_step_market_id: null,
      }).eq("id", rid);
    }
  }
  await finalizeDecisionAudit(service, marketId, {
    anomalyFlags: ["refund", reason],
    operatorIntervention: false,
  });
}

/**
 * Cancel an open or locked market and refund all active/locked bets.
 * Used when a live condition (e.g. route deviation) voids the bet before
 * normal settlement.
 */
export async function cancelAndRefundMarket(marketId: string, reason: string) {
  unstable_noStore();
  const service = await createServiceClient();

  const { data: market } = await service
    .from("live_betting_markets")
    .select("id, status")
    .eq("id", marketId)
    .maybeSingle();

  if (!market) return { error: "Market not found" };
  const status = (market as { status: string }).status;
  if (status === "cancelled" || status === "settled") {
    return { status: "already_done" as const };
  }

  await refundMarket(marketId, reason);
  return { status: "refund" as const, reason };
}

async function settleMarketWithWinner(
  marketId: string,
  winningOptionId: string,
  reason: string,
) {
  const service = await createServiceClient();
  const { data: bets } = await service
    .from("live_bets")
    .select("id, user_id, option_id, stake_amount")
    .eq("market_id", marketId)
    .eq("status", "locked");

  const betRows = (bets ?? []).map((b) => ({
    userId: b.user_id as string,
    optionId: b.option_id as string,
    stakeAmount: b.stake_amount as number,
  }));

  const payouts = Markets.computeParimutuelPayouts(betRows, winningOptionId);
  const settledAt = new Date().toISOString();

  for (let i = 0; i < (bets ?? []).length; i++) {
    const b = (bets ?? [])[i];
    const p = payouts[i];
    const { data: wallet } = await service
      .from("wallets")
      .select("balance_demo")
      .eq("user_id", p.userId)
      .maybeSingle();
    const balance = (wallet as { balance_demo: number } | null)?.balance_demo ?? 0;
    if (p.payoutAmount > 0) {
      await service
        .from("wallets")
        .update({ balance_demo: balance + p.payoutAmount })
        .eq("user_id", p.userId);
    }
    await service
      .from("live_bets")
      .update({
        status: p.won ? "settled_win" : "settled_loss",
        settled_at: settledAt,
        won: p.won,
        payout_amount: p.payoutAmount,
      })
      .eq("id", b.id as string);
  }

  await service
    .from("live_betting_markets")
    .update({
      status: "settled",
      locked_outcome_option_id: winningOptionId,
      settlement_reason: reason,
    })
    .eq("id", marketId);

  const { data: market } = await service
    .from("live_betting_markets")
    .select("room_id, live_session_id")
    .eq("id", marketId)
    .maybeSingle();
  if (market) {
    const rid = (market as { room_id: string }).room_id;
    await service.from("live_room_events").insert({
      room_id: rid,
      market_id: marketId,
      event_type: "market_settled",
      payload: { winningOptionId, reason },
    });
    /**
     * Same rationale as `refundMarket` — only knock the room back to
     * `waiting_for_next_market` when the freshly-settled market is still the
     * one displayed in the viewer popup. Background sweeps for orphan
     * locked markets must not clear the active card.
     */
    const { data: roomNow } = await service
      .from("live_rooms")
      .select("current_market_id, current_step_market_id")
      .eq("id", rid)
      .maybeSingle();
    const rn = roomNow as { current_market_id: string | null; current_step_market_id: string | null } | null;
    if (rn?.current_market_id === marketId) {
      await service
        .from("live_rooms")
        .update({
          phase: "waiting_for_next_market",
          current_market_id: null,
          last_event_at: new Date().toISOString(),
        })
        .eq("id", rid);
    } else if (rn?.current_step_market_id === marketId) {
      // Step slot: clear the pointer but do NOT touch the main phase so
      // any concurrent zone/turn bet keeps running undisturbed.
      await service
        .from("live_rooms")
        .update({
          current_step_market_id: null,
          last_event_at: new Date().toISOString(),
        })
        .eq("id", rid);
    }
  }

  await finalizeDecisionAudit(service, marketId, { anomalyFlags: [], operatorIntervention: false });

  const liveSessionId = (market as { live_session_id?: string } | null)?.live_session_id;
  const { data: sess } = liveSessionId
    ? await service
        .from("character_live_sessions")
        .select("character_id")
        .eq("id", liveSessionId)
        .maybeSingle()
    : { data: null };
  const characterId = (sess as { character_id?: string } | null)?.character_id;
  if (characterId) {
    const winners = payouts.filter((p) => p.won).length;
    const total = payouts.length;
    const crowdAcc = total > 0 ? winners / total : null;
    const { data: pub } = await service
      .from("character_public_game_stats")
      .select("favorite_turn_tendencies")
      .eq("character_id", characterId)
      .maybeSingle();
    const fav = ((pub as { favorite_turn_tendencies?: Record<string, number> } | null)?.favorite_turn_tendencies ??
      {}) as Record<string, number>;
    fav[winningOptionId] = (fav[winningOptionId] ?? 0) + 1;

    // Detect a missed turn: market had directional turn options but driver went straight.
    const winId = winningOptionId.toLowerCase();
    const wentStraight = winId.includes("straight") || winId.includes("continue") || winId.includes("forward");
    const settledOptionSet = (bets != null
      ? (await service.from("live_betting_markets").select("option_set").eq("id", marketId).maybeSingle()).data
      : null) as { option_set?: Array<{ id: string; label?: string }> } | null;
    const marketHadTurns = (settledOptionSet?.option_set ?? []).some((o) => {
      const ol = (o.id + " " + (o.label ?? "")).toLowerCase();
      return ol.includes("left") || ol.includes("right") || ol.includes("turn");
    });
    const isMissedTurn = wentStraight && marketHadTurns;

    const { data: currentDriverStats } = await service
      .from("character_public_game_stats")
      .select("missed_turns_total")
      .eq("character_id", characterId)
      .maybeSingle();
    const currentMissed = (currentDriverStats as { missed_turns_total?: number } | null)?.missed_turns_total ?? 0;

    await service.from("character_public_game_stats").upsert(
      {
        character_id: characterId,
        crowd_prediction_accuracy: crowdAcc,
        favorite_turn_tendencies: fav,
        missed_turns_total: isMissedTurn ? currentMissed + 1 : currentMissed,
        updated_at: settledAt,
      },
      { onConflict: "character_id" },
    );

    if (isMissedTurn) {
      await service.from("character_route_game_state").upsert(
        {
          character_id: characterId,
          live_session_id: liveSessionId,
          missed_turn: true,
          updated_at: settledAt,
        },
        { onConflict: "character_id" },
      );
    }
    await applyBehaviorLearningNudges(service, {
      characterId,
      winningOptionId,
      reason,
      settledAt,
    });
  }

  return { status: "settled" as const, winningOptionId };
}
