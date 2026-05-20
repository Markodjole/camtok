import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getOrBuildGridSpecForRoom } from "@/lib/live/grid/gridSpecForRoom";
import { acquireTickLock, releaseTickLock, runRoomTick } from "@/lib/live/tick/runRoomTick";
import {
  cellIdForPosition,
  gridCellCenter,
  parseGridOptionId,
} from "@/lib/live/grid/cityGrid500";
import { metersBetween } from "@/lib/live/routing/geometry";
import {
  NEXT_ZONE_TRIGGER_M,
  ZONE_EXIT_CENTER_TRIGGER_M,
} from "@/lib/live/betting/betWindowConstants";

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
    .select("id, phase, current_market_id, live_session_id, tick_locked_until, last_event_at, queued_triggers")
    .eq("id", roomId)
    .maybeSingle();

  if (!room) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const sessionId = (room as { live_session_id: string }).live_session_id;

  // Session
  const { data: session } = await service
    .from("character_live_sessions")
    .select("id, status, transport_mode, last_heartbeat_at")
    .eq("id", sessionId)
    .maybeSingle();

  // GPS
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

  // Grid spec + cell analysis
  const specRes = await getOrBuildGridSpecForRoom(service, roomId, sessionId);
  let cellInfo: Record<string, unknown> = { resolved: false };

  if (specRes.ok && latestGps) {
    const g = latestGps as { normalized_lat: number | null; normalized_lng: number | null; raw_lat: number; raw_lng: number };
    const lat = g.normalized_lat ?? g.raw_lat;
    const lng = g.normalized_lng ?? g.raw_lng;
    const cellId = cellIdForPosition(specRes.spec, lat, lng);
    const parsed = cellId ? parseGridOptionId(cellId) : null;

    if (parsed) {
      const center = gridCellCenter(specRes.spec, parsed.row, parsed.col);
      const distM = metersBetween({ lat, lng }, center);
      const cellKey = `cell:r${parsed.row}:c${parsed.col}`;

      // Check fired phases for this cell
      const { data: zoneMarkets } = await service
        .from("live_betting_markets")
        .select("subtitle")
        .eq("live_session_id", sessionId)
        .eq("market_type", "zone_exit_time");

      const firedPhases: string[] = [];
      for (const row of zoneMarkets ?? []) {
        try {
          const meta = JSON.parse((row as { subtitle: string | null }).subtitle ?? "{}") as { cellKey?: string; triggerPhase?: string };
          if (meta.cellKey === cellKey && meta.triggerPhase) firedPhases.push(meta.triggerPhase);
        } catch { /* skip */ }
      }

      // Check if next_zone fired for this cell
      const { data: gridMarkets } = await service
        .from("live_betting_markets")
        .select("subtitle")
        .eq("room_id", roomId)
        .eq("market_type", "city_grid")
        .order("opens_at", { ascending: false })
        .limit(30);

      const nextZoneFired = (gridMarkets ?? []).some((row) => {
        try {
          const meta = JSON.parse((row as { subtitle: string | null }).subtitle ?? "{}") as { cellKey?: string };
          return meta.cellKey === cellKey;
        } catch { return false; }
      });

      cellInfo = {
        resolved: true,
        cellId,
        cellKey,
        distanceToCenterM: Math.round(distM),
        firedPhases,
        nextZoneFired,
        eligibleTriggers: {
          next_zone: !nextZoneFired && distM <= NEXT_ZONE_TRIGGER_M,
          zone_exit_entry: !firedPhases.includes("entry"),
          zone_exit_center70m: !firedPhases.includes("center_70m") && distM <= ZONE_EXIT_CENTER_TRIGGER_M,
          zone_exit_exitOuter: !firedPhases.includes("exit_outer") && firedPhases.includes("center_70m"),
        },
      };
    } else {
      cellInfo = { resolved: false, reason: "cellId not resolved for current position", cellId };
    }
  }

  // Recent room events (last 10) — shows tick activity, market opens, errors
  const { data: recentEvents } = await service
    .from("live_room_events")
    .select("event_type, payload, created_at")
    .eq("room_id", roomId)
    .order("created_at", { ascending: false })
    .limit(10);

  // Recent markets (last 5)
  const { data: recentMarkets } = await service
    .from("live_betting_markets")
    .select("id, market_type, status, opens_at, subtitle")
    .eq("room_id", roomId)
    .order("opens_at", { ascending: false })
    .limit(5);

  // Current market
  let currentMarket = null;
  const mId = (room as { current_market_id: string | null }).current_market_id;
  if (mId) {
    const { data: m } = await service
      .from("live_betting_markets")
      .select("id, market_type, status, opens_at, locks_at")
      .eq("id", mId)
      .maybeSingle();
    currentMarket = m;
  }

  return NextResponse.json({
    room: {
      phase: (room as { phase: string }).phase,
      tickLockedUntil: (room as { tick_locked_until: string | null }).tick_locked_until,
      lastEventAt: (room as { last_event_at: string | null }).last_event_at,
      queuedTriggers: (room as { queued_triggers: unknown }).queued_triggers,
    },
    session: session ? {
      status: (session as { status: string }).status,
      transportMode: (session as { transport_mode: string }).transport_mode,
      lastHeartbeatAt: (session as { last_heartbeat_at: string | null }).last_heartbeat_at,
    } : null,
    gps: { totalPoints: gpsCount ?? 0, latest: latestGps ?? null },
    gridSpec: specRes.ok
      ? { ok: true, cellMeters: specRes.spec.cellMeters, cityLabel: specRes.spec.cityLabel }
      : { ok: false, reason: (specRes as { error: string }).error },
    cell: cellInfo,
    currentMarket,
    recentMarkets: recentMarkets ?? [],
    recentEvents: recentEvents ?? [],
  });
}

// POST — run one tick and return the full result including opener errors
export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ roomId: string }> },
) {
  const { roomId } = await ctx.params;
  const service = await createServiceClient();
  const locked = await acquireTickLock(service, roomId);
  if (!locked) return NextResponse.json({ error: "tick_locked" });
  try {
    const result = await runRoomTick(roomId, service);
    return NextResponse.json(result);
  } finally {
    await releaseTickLock(service, roomId);
  }
}
