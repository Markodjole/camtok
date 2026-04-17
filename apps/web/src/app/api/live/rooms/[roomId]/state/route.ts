import { NextRequest, NextResponse } from "next/server";
import { getLiveRoomDetail } from "@/actions/live-feed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ roomId: string }> },
) {
  const { roomId } = await ctx.params;
  const res = await getLiveRoomDetail(roomId);
  if (!res.room) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json(res);
}
