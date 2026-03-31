"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { calculateSettlement, calculateBettorPayout } from "@bettok/betting";
import { mockScoreSettlement } from "@bettok/story-engine";
import { SETTLEMENT_ALGORITHM_VERSION } from "@bettok/core";

export async function settleClipNode(clipNodeId: string) {
  const supabase = await createServiceClient();

  const { data: clipNode } = await supabase
    .from("clip_nodes")
    .select("*")
    .eq("id", clipNodeId)
    .single();

  if (!clipNode) return { error: "Clip not found" };
  if (clipNode.status !== "continuation_ready") {
    return { error: "Clip not in continuation_ready state" };
  }

  const { data: continuationJob } = await supabase
    .from("continuation_jobs")
    .select("*")
    .eq("clip_node_id", clipNodeId)
    .eq("status", "published")
    .single();

  if (!continuationJob) return { error: "No published continuation found" };

  const { data: markets } = await supabase
    .from("prediction_markets")
    .select("*, market_sides(*)")
    .eq("clip_node_id", clipNodeId)
    .in("status", ["open", "locked"]);

  if (!markets || markets.length === 0) {
    return { error: "No markets to settle" };
  }

  const { data: settlementResult, error: srError } = await supabase
    .from("settlement_results")
    .insert({
      clip_node_id: clipNodeId,
      continuation_clip_node_id: continuationJob.result_clip_node_id,
      algorithm_version: SETTLEMENT_ALGORITHM_VERSION,
      summary: continuationJob.continuation_summary || "Settlement complete",
    })
    .select()
    .single();

  if (srError) return { error: "Failed to create settlement result" };

  const outcomeParts: string[] = [];
  const selectedCandidates = Array.isArray(continuationJob.selected_candidates)
    ? continuationJob.selected_candidates as Array<Record<string, unknown>>
    : [];
  const selectedSummary = selectedCandidates
    .slice(0, 2)
    .map((c) => {
      const label = String(c.label ?? "unknown action");
      const vw = typeof c.videoWeight === "number" ? c.videoWeight.toFixed(2) : null;
      const pw = typeof c.plausibilityWeight === "number" ? c.plausibilityWeight.toFixed(2) : null;
      const rationale = typeof c.plausibilityReasoning === "string" ? c.plausibilityReasoning : "";
      const weightBits = [vw ? `video=${vw}` : "", pw ? `logic=${pw}` : ""].filter(Boolean).join(", ");
      return `${label}${weightBits ? ` (${weightBits})` : ""}${rationale ? ` — ${rationale}` : ""}`;
    })
    .join(" | ");
  let resolutionReason = continuationJob.scene_explanation ||
    continuationJob.continuation_summary ||
    "Settlement complete";
  if (selectedSummary) {
    resolutionReason = `Decision basis: ${selectedSummary}. ${resolutionReason}`;
  }
  /** Per-user net profit (positive) or loss (negative) across all bets on this clip */
  const userNetPayout = new Map<string, number>();

  for (const market of markets) {
    const score = mockScoreSettlement(
      market.market_key,
      continuationJob.continuation_summary || ""
    );

    const yesSide = market.market_sides.find(
      (s: Record<string, unknown>) => s.side_key === "yes"
    );
    const noSide = market.market_sides.find(
      (s: Record<string, unknown>) => s.side_key === "no"
    );

    const yesPool = Number(yesSide?.pool_amount || 0);
    const noPool = Number(noSide?.pool_amount || 0);

    const settlement = calculateSettlement({
      yesPool,
      noPool,
      yesCorrectness: score.yes_correctness,
    });

    await supabase.from("settlement_side_results").insert({
      settlement_result_id: settlementResult.id,
      prediction_market_id: market.id,
      yes_correctness: score.yes_correctness,
      no_correctness: score.no_correctness,
      winner_side: settlement.winnerSide,
      strength: settlement.strength,
      transfer_amount: settlement.transferAmount,
      explanation_short: score.explanation_short,
      explanation_long: score.explanation_long,
      confidence: score.confidence,
      evidence_bullets: score.evidence_bullets,
    });

    const canonical = (market as Record<string, string>).canonical_text || "Prediction";
    const winnerLabel = settlement.winnerSide === "yes" ? "YES" : "NO";
    outcomeParts.push(`${canonical}: ${winnerLabel}`);
    if (outcomeParts.length === 1 && score.explanation_short) {
      resolutionReason = `${resolutionReason} Market match: ${score.explanation_short}`;
    }

    const { data: bets } = await supabase
      .from("bets")
      .select("*")
      .eq("prediction_market_id", market.id)
      .in("status", ["active", "locked"]);

    for (const bet of bets || []) {
      const isWinningSide = bet.side_key === settlement.winnerSide;
      const sidePool = bet.side_key === "yes" ? yesPool : noPool;
      const sideFinalPool =
        bet.side_key === "yes"
          ? settlement.yesFinalPool
          : settlement.noFinalPool;

      const payout = calculateBettorPayout({
        userStake: Number(bet.stake_amount),
        sidePool,
        sideFinalPool,
      });

      await supabase
        .from("bets")
        .update({
          status: isWinningSide ? "settled_win" : "settled_loss",
          payout_amount: payout,
          settled_at: new Date().toISOString(),
        })
        .eq("id", bet.id);

      const { data: hold } = await supabase
        .from("wallet_holds")
        .select("*")
        .eq("bet_id", bet.id)
        .eq("status", "active")
        .single();

      if (hold) {
        await supabase
          .from("wallet_holds")
          .update({
            status: "converted",
            released_at: new Date().toISOString(),
          })
          .eq("id", hold.id);

        const { data: wallet } = await supabase
          .from("wallets")
          .select("*")
          .eq("id", hold.wallet_id)
          .single();

        if (wallet) {
          const txType = isWinningSide ? "bet_win" : "bet_loss";
          const txAmount = isWinningSide
            ? payout
            : -(Number(bet.stake_amount) - payout);

          const newBalance = Number(wallet.balance) + txAmount;

          await supabase.from("wallet_transactions").insert({
            wallet_id: wallet.id,
            type: txType,
            amount: txAmount,
            balance_after: newBalance,
            reference_type: "bet",
            reference_id: bet.id,
            description: `${isWinningSide ? "Won" : "Lost"} bet on "${market.canonical_text}"`,
          });

          const updates: Record<string, number> = { balance: newBalance };
          if (isWinningSide) {
            updates.total_won = Number(wallet.total_won) + (payout - Number(bet.stake_amount));
          } else {
            updates.total_lost = Number(wallet.total_lost) + (Number(bet.stake_amount) - payout);
          }

          await supabase
            .from("wallets")
            .update(updates)
            .eq("id", wallet.id);
        }
      }

      const net = isWinningSide
        ? payout - Number(bet.stake_amount)
        : -(Number(bet.stake_amount) - payout);
      const prev = userNetPayout.get(bet.user_id) ?? 0;
      userNetPayout.set(bet.user_id, prev + net);

      await supabase.from("notifications").insert({
        user_id: bet.user_id,
        type: isWinningSide ? "bet_won" : "bet_lost",
        title: isWinningSide ? "You won!" : "You lost",
        body: `Your bet on "${market.canonical_text}" has been settled. ${isWinningSide ? `You won $${(payout - Number(bet.stake_amount)).toFixed(2)}` : `You lost $${(Number(bet.stake_amount) - payout).toFixed(2)}`}`,
        link: `/clip/${clipNodeId}`,
        reference_type: "bet",
        reference_id: bet.id,
      });
    }

    await supabase
      .from("prediction_markets")
      .update({ status: "settled" })
      .eq("id", market.id);
  }

  const winningOutcomeText = outcomeParts.length > 0 ? outcomeParts.join(" · ") : "Settled";
  const now = new Date().toISOString();

  await supabase
    .from("clip_nodes")
    .update({
      status: "settled",
      winning_outcome_text: winningOutcomeText,
      resolution_reason_text: resolutionReason,
      resolved_at: now,
    })
    .eq("id", clipNodeId);

  for (const [userId, net] of userNetPayout) {
    const payoutLine =
      net > 0 ? `You won $${net.toFixed(2)}` : net < 0 ? `You lost $${Math.abs(net).toFixed(2)}` : "";
    await supabase.from("notifications").insert({
      user_id: userId,
      type: "clip_resolved",
      title: "Your clip resolved",
      body: [`Winning outcome: ${winningOutcomeText}`, payoutLine].filter(Boolean).join(". "),
      link: `/clip/${clipNodeId}`,
      reference_type: "clip",
      reference_id: clipNodeId,
    });
  }

  return { data: settlementResult };
}
