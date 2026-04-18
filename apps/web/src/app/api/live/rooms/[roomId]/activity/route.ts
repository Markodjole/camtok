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
  const { data: { user } } = await supabase.auth.getUser();

  const { data: events } = await service
    .from("live_room_events")
    .select("id, event_type, market_id, payload, occurred_at")
    .eq("room_id", roomId)
    .order("occurred_at", { ascending: false })
    .limit(40);

  type Row = { market_id: string; won: boolean; stake_amount: number; payout_amount: number; status: string; settled_at: string | null };
  let mySettlements: Row[] = [];
  if (user) {
    const { data: rows } = await service
      .from("live_bets")
      .select("market_id, won, stake_amount, payout_amount, status, settled_at")
      .eq("room_id", roomId)
      .eq("user_id", user.id)
      .in("status", ["settled_win", "settled_loss"])
      .order("settled_at", { ascending: false })
      .limit(8);
    mySettlements = (rows ?? []) as unknown as Row[];
  }

  return NextResponse.json({
    events: events ?? [],
    mySettlements,
  });
}
