import { NextRequest, NextResponse } from "next/server";
import {
  startLiveSession,
  startLiveSessionForUser,
} from "@/actions/live-sessions";
import { getBearerUser } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));

  const bearerUser = await getBearerUser(req);
  const res = bearerUser
    ? await startLiveSessionForUser(bearerUser.id, body)
    : await startLiveSession(body);

  if ("error" in res) {
    const status = res.error === "Not authenticated" ? 401 : 400;
    return NextResponse.json({ error: res.error }, { status });
  }
  return NextResponse.json(res);
}
