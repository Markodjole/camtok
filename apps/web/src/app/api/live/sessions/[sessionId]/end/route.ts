import { NextRequest, NextResponse } from "next/server";
import {
  endLiveSession,
  endLiveSessionForUser,
} from "@/actions/live-sessions";
import { getBearerUser } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await ctx.params;

  const bearerUser = await getBearerUser(req);
  const res = bearerUser
    ? await endLiveSessionForUser(bearerUser.id, sessionId)
    : await endLiveSession(sessionId);

  if ("error" in res) {
    const status = res.error === "Not authenticated" ? 401 : 400;
    return NextResponse.json({ error: res.error }, { status });
  }
  return NextResponse.json(res);
}
