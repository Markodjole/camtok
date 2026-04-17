import { NextRequest, NextResponse } from "next/server";
import { heartbeatLiveSession } from "@/actions/live-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const res = await heartbeatLiveSession({ sessionId, ...body });
  if ("error" in res) {
    return NextResponse.json({ error: res.error }, { status: 400 });
  }
  return NextResponse.json(res);
}
