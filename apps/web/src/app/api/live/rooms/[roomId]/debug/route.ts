import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getOrBuildGridSpecForRoom } from "@/lib/live/grid/gridSpecForRoom";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ roomId: string }> },
) {
  const { roomId } = await ctx.params;
  const service = await createServiceClient();

  // Room
  const { data: room } = await service
    .from("live_rooms")
    .select("id, phase, current_market_id, live_session_id, tick_locked_until, last_event_at")
    .eq("id", roomId)
    .maybeSingle();

  if (!room) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const sessionId = (room as { live_session_id: string }).live_session_id;

  // Session
  const { data: session } = await service
    .from("character_live_sessions")
    .select("id, status, transport_mode, owner_user_id, last_heartbeat_at")
    .eq("id", sessionId)
    .maybeSingle();

  // GPS count + latest point
  const { count: gpsCount } = await service
    .from("live_route_snapshots")
    .select("id", { count: "exact", head: true })
    .eq("live_session_id", sessionId);

  const { data: latestGps } = await service
    .from("live_route_snapshots")
    .select("normalized_lat,normalized_lng,raw_lat,raw_lng,heading_deg,recorded_at")
    .eq("live_session_id", sessionId)
    .order("recorded_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // Grid spec
  const specRes = await getOrBuildGridSpecForRoom(service, roomId, sessionId);

  // Current market
  let market = null;
  const mId = (room as { current_market_id: string | null }).current_market_id;
  if (mId) {
    const { data: m } = await service
      .from("live_betting_markets")
      .select("id, market_type, status, opens_at, locks_at")
      .eq("id", mId)
      .maybeSingle();
    market = m;
  }

  return NextResponse.json({
    room: {
      id: (room as { id: string }).id,
      phase: (room as { phase: string }).phase,
      tickLockedUntil: (room as { tick_locked_until: string | null }).tick_locked_until,
      lastEventAt: (room as { last_event_at: string | null }).last_event_at,
    },
    session: session
      ? {
          id: (session as { id: string }).id,
          status: (session as { status: string }).status,
          transportMode: (session as { transport_mode: string }).transport_mode,
          lastHeartbeatAt: (session as { last_heartbeat_at: string | null }).last_heartbeat_at,
        }
      : null,
    gps: {
      totalPoints: gpsCount ?? 0,
      latest: latestGps ?? null,
    },
    gridSpec: specRes.ok
      ? { ok: true, cellMeters: specRes.spec.cellMeters, cityLabel: specRes.spec.cityLabel }
      : { ok: false, reason: (specRes as { error: string }).error },
    currentMarket: market,
  });
}
