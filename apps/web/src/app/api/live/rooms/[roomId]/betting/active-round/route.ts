import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { getActiveBettingRoundPayload } from "@/lib/live/betting/activeRound";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/live/rooms/:roomId/betting/active-round
 * Engine V2 adapter: room + driver-route + selection snapshot + best plan + optional user bet.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ roomId: string }> },
) {
  const { roomId } = await ctx.params;
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const payload = await getActiveBettingRoundPayload(roomId, user?.id ?? null);
  if ("error" in payload) {
    return NextResponse.json({ error: payload.error }, { status: 404 });
  }
  return NextResponse.json(payload);
}
