import { NextRequest, NextResponse } from "next/server";
import { createServerClient, createServiceClient } from "@/lib/supabase/server";
import { Stream } from "@bettok/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await ctx.params;
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const service = await createServiceClient();
  const { data: session } = await service
    .from("character_live_sessions")
    .select("id, status")
    .eq("id", sessionId)
    .maybeSingle();
  if (!session) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if ((session as { status: string }).status !== "live") {
    return NextResponse.json({ error: "session_not_live" }, { status: 409 });
  }

  const secret = process.env.LIVE_STREAM_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "stream_disabled" },
      { status: 503 },
    );
  }

  const token = Stream.issueViewerToken(secret, sessionId);
  return NextResponse.json({ token });
}
