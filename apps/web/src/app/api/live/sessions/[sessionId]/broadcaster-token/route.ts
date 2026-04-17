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
    .select("id, owner_user_id, character_id")
    .eq("id", sessionId)
    .maybeSingle();
  if (!session || (session as { owner_user_id: string }).owner_user_id !== user.id) {
    return NextResponse.json({ error: "not_owner" }, { status: 403 });
  }

  const secret = process.env.LIVE_STREAM_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "stream_disabled", reason: "LIVE_STREAM_SECRET not configured" },
      { status: 503 },
    );
  }
  const token = Stream.issueBroadcasterToken(
    secret,
    sessionId,
    (session as { character_id: string }).character_id,
  );
  return NextResponse.json({ token });
}
