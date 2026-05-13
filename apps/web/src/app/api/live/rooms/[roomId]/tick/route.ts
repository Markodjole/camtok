/**
 * Manual / fallback tick endpoint.
 *
 * In production the server-side cron at /api/cron/live-tick drives all
 * rooms at ~1 Hz — clients no longer need to call this.  It is kept so
 * local-dev and the streamer dashboard can still trigger ticks manually.
 *
 * A CAS lock (tick_locked_until) prevents this from running concurrently
 * with the cron for the same room.
 */
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import {
  acquireTickLock,
  releaseTickLock,
  runRoomTick,
} from "@/lib/live/tick/runRoomTick";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ roomId: string }> },
) {
  const { roomId } = await ctx.params;
  const service = await createServiceClient();

  const locked = await acquireTickLock(service, roomId);
  if (!locked) {
    return NextResponse.json({ action: "busy" });
  }

  try {
    const result = await runRoomTick(roomId, service);
    if ((result as { error?: string }).error === "not_found") {
      return NextResponse.json(result, { status: 404 });
    }
    return NextResponse.json(result);
  } finally {
    await releaseTickLock(service, roomId);
  }
}
