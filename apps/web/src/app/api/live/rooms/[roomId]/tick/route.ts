import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { openSystemMarketForRoom } from "@/actions/live-markets";
import { lockMarket, revealAndSettleMarket } from "@/actions/live-settlement";

/**
 * Stateless tick worker for a single room. Designed to be called every few
 * seconds by a scheduler / cron / client poll. Advances room state:
 *   - waiting_for_next_market → tries to open a system market
 *   - market_open past locks_at → lock
 *   - market_locked past reveal_at → reveal+settle
 *
 * Idempotent: state machine guards each transition.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ roomId: string }> },
) {
  const { roomId } = await ctx.params;
  const service = await createServiceClient();

  const { data: room } = await service
    .from("live_rooms")
    .select("id, phase, current_market_id")
    .eq("id", roomId)
    .maybeSingle();
  if (!room) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const phase = (room as { phase: string }).phase;
  const marketId = (room as { current_market_id: string | null }).current_market_id;

  if (phase === "waiting_for_next_market") {
    const r = await openSystemMarketForRoom(roomId);
    return NextResponse.json({ action: "try_open_market", ...r });
  }

  if ((phase === "market_open" || phase === "market_locked") && marketId) {
    const { data: market } = await service
      .from("live_betting_markets")
      .select("id, status, locks_at, reveal_at")
      .eq("id", marketId)
      .maybeSingle();
    if (!market) return NextResponse.json({ action: "no_market" });

    const now = Date.now();
    const locksAt = new Date((market as { locks_at: string }).locks_at).getTime();
    const revealAt = new Date((market as { reveal_at: string }).reveal_at).getTime();
    const status = (market as { status: string }).status;

    if (status === "open" && now >= locksAt) {
      const r = await lockMarket(marketId);
      return NextResponse.json({ action: "lock", ...r });
    }
    if (status === "locked" && now >= revealAt) {
      const r = await revealAndSettleMarket(marketId);
      return NextResponse.json({ action: "reveal", ...r });
    }
  }

  return NextResponse.json({ action: "noop", phase });
}
