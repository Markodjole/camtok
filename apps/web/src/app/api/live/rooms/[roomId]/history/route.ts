import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ roomId: string }> },
) {
  const { roomId } = await ctx.params;
  const service = await createServiceClient();

  const { data: markets } = await service
    .from("live_betting_markets")
    .select(
      "id, title, market_type, option_set, locked_outcome_option_id, lock_commit_hash, settlement_reason, total_bet_amount, participant_count, locks_at, reveal_at, updated_at",
    )
    .eq("room_id", roomId)
    .in("status", ["settled", "cancelled"])
    .order("updated_at", { ascending: false })
    .limit(10);

  if (!markets?.length) return NextResponse.json({ markets: [] });

  const marketIds = markets.map((m) => m.id as string);

  const [{ data: audits }, { data: allBets }] = await Promise.all([
    service
      .from("character_decision_audit_log")
      .select(
        "market_id, lock_timestamp, reveal_timestamp, gps_confidence_score, anomaly_flags, operator_intervention_flag",
      )
      .in("market_id", marketIds),
    service
      .from("live_bets")
      .select("market_id, option_id, stake_amount")
      .in("market_id", marketIds),
  ]);

  const auditMap = new Map((audits ?? []).map((a) => [a.market_id as string, a]));

  type BetRow = { market_id: string; option_id: string; stake_amount: number };
  const betsByMarket = new Map<string, BetRow[]>();
  for (const b of (allBets ?? []) as BetRow[]) {
    const arr = betsByMarket.get(b.market_id) ?? [];
    arr.push(b);
    betsByMarket.set(b.market_id, arr);
  }

  const enriched = markets.map((m) => {
    const audit = auditMap.get(m.id as string);
    const bets = betsByMarket.get(m.id as string) ?? [];
    const totalStake = bets.reduce((s, b) => s + Number(b.stake_amount), 0);

    type OptionRow = { id: string; label: string; shortLabel?: string | null };
    const optionSet = (m.option_set ?? []) as OptionRow[];

    const options = optionSet.map((opt) => {
      const optStake = bets
        .filter((b) => b.option_id === opt.id)
        .reduce((s, b) => s + Number(b.stake_amount), 0);
      return {
        id: opt.id,
        label: opt.label,
        shortLabel: opt.shortLabel ?? null,
        crowd_pct: totalStake > 0 ? Math.round((optStake / totalStake) * 100) : null,
        bet_count: bets.filter((b) => b.option_id === opt.id).length,
      };
    });

    return {
      id: m.id as string,
      title: m.title as string,
      market_type: m.market_type as string,
      options,
      winning_option_id: (m.locked_outcome_option_id as string | null) ?? null,
      commit_hash: (m.lock_commit_hash as string | null) ?? null,
      settlement_reason: (m.settlement_reason as string | null) ?? null,
      total_bet_amount: Number(m.total_bet_amount ?? 0),
      participant_count: Number(m.participant_count ?? 0),
      locks_at: m.locks_at as string,
      reveal_at: m.reveal_at as string,
      lock_timestamp: (audit?.lock_timestamp as string | null) ?? null,
      reveal_timestamp: (audit?.reveal_timestamp as string | null) ?? null,
      gps_confidence: (audit?.gps_confidence_score as number | null) ?? null,
      anomaly_flags: (audit?.anomaly_flags as string[] | null) ?? [],
      operator_intervention: (audit?.operator_intervention_flag as boolean | null) ?? false,
    };
  });

  return NextResponse.json({ markets: enriched });
}
