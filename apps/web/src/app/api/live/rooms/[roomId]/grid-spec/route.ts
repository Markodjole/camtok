import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getOrBuildGridSpecForRoom } from "@/lib/live/grid/gridSpecForRoom";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Room-scoped 500 m grid — reused from prior zone markets or built from driver GPS. */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ roomId: string }> },
) {
  const { roomId } = await ctx.params;
  const service = await createServiceClient();

  const { data: room } = await service
    .from("live_rooms")
    .select("live_session_id")
    .eq("id", roomId)
    .maybeSingle();

  if (!room) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const sessionId = (room as { live_session_id: string }).live_session_id;
  const specRes = await getOrBuildGridSpecForRoom(service, roomId, sessionId);

  if (!specRes.ok) {
    return NextResponse.json({ gridSpec: null, error: specRes.error });
  }

  return NextResponse.json({
    gridSpec: specRes.spec,
    source: specRes.source,
  });
}
