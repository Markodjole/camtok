import { NextRequest, NextResponse } from "next/server";
import { createServerClient, createServiceClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ roomId: string }> },
) {
  const { roomId } = await ctx.params;
  const service = await createServiceClient();
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: events } = await service
    .from("live_room_events")
    .select("id, event_type, market_id, payload, occurred_at")
    .eq("room_id", roomId)
    .order("occurred_at", { ascending: false })
    .limit(40);

  type EnrichedSettlement = {
    market_id: string;
    title: string;
    won: boolean;
    stake_amount: number;
    payout_amount: number;
    status: string;
    settled_at: string | null;
    my_option_id: string;
    winning_option_id: string | null;
    options: Array<{
      id: string;
      label: string;
      shortLabel: string | null;
      crowd_pct: number | null;
    }>;
  };

  let mySettlements: EnrichedSettlement[] = [];

  if (user) {
    const { data: betRows } = await service
      .from("live_bets")
      .select("market_id, won, stake_amount, payout_amount, status, settled_at, option_id")
      .eq("room_id", roomId)
      .eq("user_id", user.id)
      .in("status", ["settled_win", "settled_loss"])
      .order("settled_at", { ascending: false })
      .limit(8);

    const myBets = (betRows ?? []) as Array<{
      market_id: string;
      won: boolean;
      stake_amount: number;
      payout_amount: number;
      status: string;
      settled_at: string | null;
      option_id: string;
    }>;

    if (myBets.length > 0) {
      const marketIds = [...new Set(myBets.map((b) => b.market_id))];

      const [{ data: marketRows }, { data: crowdBets }] = await Promise.all([
        service
          .from("live_betting_markets")
          .select("id, title, option_set, locked_outcome_option_id")
          .in("id", marketIds),
        service
          .from("live_bets")
          .select("market_id, option_id, stake_amount")
          .in("market_id", marketIds),
      ]);

      const marketMap = new Map(
        (marketRows ?? []).map((m) => [m.id as string, m]),
      );

      type CrowdBet = { market_id: string; option_id: string; stake_amount: number };
      const betsByMarket = new Map<string, CrowdBet[]>();
      for (const b of (crowdBets ?? []) as CrowdBet[]) {
        const arr = betsByMarket.get(b.market_id) ?? [];
        arr.push(b);
        betsByMarket.set(b.market_id, arr);
      }

      mySettlements = myBets.map((b) => {
        const market = marketMap.get(b.market_id);
        const bets = betsByMarket.get(b.market_id) ?? [];
        const totalStake = bets.reduce((s, x) => s + Number(x.stake_amount), 0);

        type OptionRow = { id: string; label: string; shortLabel?: string | null };
        const optionSet = (market?.option_set ?? []) as OptionRow[];

        const options = optionSet.map((opt) => {
          const optStake = bets
            .filter((x) => x.option_id === opt.id)
            .reduce((s, x) => s + Number(x.stake_amount), 0);
          return {
            id: opt.id,
            label: opt.label,
            shortLabel: opt.shortLabel ?? null,
            crowd_pct:
              totalStake > 0 ? Math.round((optStake / totalStake) * 100) : null,
          };
        });

        return {
          market_id: b.market_id,
          title: (market?.title as string | undefined) ?? "",
          won: b.won,
          stake_amount: Number(b.stake_amount),
          payout_amount: Number(b.payout_amount ?? 0),
          status: b.status,
          settled_at: b.settled_at,
          my_option_id: b.option_id,
          winning_option_id:
            (market?.locked_outcome_option_id as string | null) ?? null,
          options,
        };
      });
    }
  }

  return NextResponse.json({
    events: events ?? [],
    mySettlements,
  });
}
