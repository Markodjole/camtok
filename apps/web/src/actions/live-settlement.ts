"use server";

import { unstable_noStore } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import {
  Markets,
  RouteState,
  type LiveMarketOption,
  type RouteDecisionOption,
} from "@bettok/live";

type LockEvidence = {
  currentNodeId: string;
  candidateOptionIds: string[];
  selectedOptionId: string;
  normalizedSnapshotTs: string;
  etaToDecisionSeconds: number | null;
  confidence: number;
};

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
    .select("id, room_id, live_session_id, status, option_set, decision_node_id, locks_at")
    .eq("id", marketId)
    .maybeSingle();
  if (!market) return { error: "Market not found" };
  if ((market as { status: string }).status !== "open") {
    return { error: "Market not open" };
  }

  const { data: snapshot } = await service
    .from("live_route_snapshots")
    .select("id, recorded_at, normalized_lat, normalized_lng, speed_mps, heading_deg, confidence_score")
    .eq("live_session_id", (market as { live_session_id: string }).live_session_id)
    .order("recorded_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const options = (market as { option_set: LiveMarketOption[] }).option_set;
  const selected = options[0].id;
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

  await service
    .from("live_rooms")
    .update({ phase: "market_locked", last_event_at: new Date().toISOString() })
    .eq("id", (market as { room_id: string }).room_id);

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
 * After reveal window, compare actual committed path against locked
 * options. If ambiguous / low confidence, refund all bets.
 */
export async function revealAndSettleMarket(marketId: string) {
  unstable_noStore();
  const service = await createServiceClient();

  const { data: market } = await service
    .from("live_betting_markets")
    .select("id, room_id, live_session_id, status, option_set, decision_node_id, reveal_at")
    .eq("id", marketId)
    .maybeSingle();
  if (!market) return { error: "Market not found" };
  if ((market as { status: string }).status !== "locked") {
    return { error: "Market not locked" };
  }

  const { data: decision } = await service
    .from("route_decision_nodes")
    .select("options")
    .eq("id", (market as { decision_node_id: string | null }).decision_node_id ?? "")
    .maybeSingle();

  const revealAtMs = new Date((market as { reveal_at: string }).reveal_at).getTime();
  const since = new Date(revealAtMs - 15_000).toISOString();

  const { data: points } = await service
    .from("live_route_snapshots")
    .select("recorded_at, normalized_lat, normalized_lng, speed_mps, heading_deg, confidence_score")
    .eq("live_session_id", (market as { live_session_id: string }).live_session_id)
    .gte("recorded_at", since)
    .order("recorded_at", { ascending: true });

  const committed = (points ?? []).map((r) => ({
    recordedAt: r.recorded_at as string,
    lat: r.normalized_lat as number,
    lng: r.normalized_lng as number,
    speedMps: (r.speed_mps as number | null) ?? undefined,
    headingDeg: (r.heading_deg as number | null) ?? undefined,
    normalizedLat: r.normalized_lat as number,
    normalizedLng: r.normalized_lng as number,
    confidence: (r.confidence_score as number | null) ?? 0.5,
    discarded: false,
  }));

  const options = (market as { option_set: LiveMarketOption[] }).option_set;
  const decisionOptions = (decision as { options: RouteDecisionOption[] } | null)?.options ?? [];
  const result = RouteState.revealFromMovement(
    options,
    decisionOptions.length ? { options: decisionOptions } : null,
    committed,
  );

  if (result.status !== "matched") {
    await refundMarket(marketId, result.reason);
    return { status: result.status, reason: result.reason };
  }

  return await settleMarketWithWinner(marketId, result.winningOptionId, result.reason);
}

async function refundMarket(marketId: string, reason: string) {
  const service = await createServiceClient();
  const { data: bets } = await service
    .from("live_bets")
    .select("id, user_id, stake_amount")
    .eq("market_id", marketId)
    .eq("status", "locked");

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
    .select("room_id")
    .eq("id", marketId)
    .maybeSingle();
  if (market) {
    await service.from("live_room_events").insert({
      room_id: (market as { room_id: string }).room_id,
      market_id: marketId,
      event_type: "market_cancelled",
      payload: { reason },
    });
    await service.from("live_rooms").update({
      phase: "waiting_for_next_market",
      current_market_id: null,
    }).eq("id", (market as { room_id: string }).room_id);
  }
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
        settled_at: new Date().toISOString(),
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
    .select("room_id")
    .eq("id", marketId)
    .maybeSingle();
  if (market) {
    await service.from("live_room_events").insert({
      room_id: (market as { room_id: string }).room_id,
      market_id: marketId,
      event_type: "market_settled",
      payload: { winningOptionId, reason },
    });
    await service
      .from("live_rooms")
      .update({
        phase: "waiting_for_next_market",
        current_market_id: null,
        last_event_at: new Date().toISOString(),
      })
      .eq("id", (market as { room_id: string }).room_id);
  }

  return { status: "settled" as const, winningOptionId };
}
