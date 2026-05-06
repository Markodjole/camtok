import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { openSystemMarketForRoom } from "@/actions/live-markets";
import { openCityGridMarketForRoom } from "@/actions/live-city-grid-market";
import {
  openEngineMarketForRoom,
  shouldSettleEngineMarket,
} from "@/actions/live-engine-market";
import { lockMarket, revealAndSettleMarket } from "@/actions/live-settlement";
import { LIVE_BET_LOCK_DISTANCE_M } from "@/lib/live/liveBetLockDistance";
import { liveBetRelaxServer } from "@/lib/live/liveBetRelax";
import { metersBetween } from "@/lib/live/routing/geometry";
import { isEngineMarketType } from "@/lib/live/betting/engineMarketOptions";

/**
 * Stateless tick worker for a single room. Designed to be called every few
 * seconds by a scheduler / cron / client poll. Advances room state:
 *   - waiting_for_next_market → tries to open a system market
 *   - market_open: lock when vehicle within LIVE_BET_LOCK_DISTANCE_M of the
 *     turn point, OR when the safety-timeout `locks_at` passes.
 *   - market_locked past reveal_at → reveal+settle
 *
 * Idempotent: state machine guards each transition.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ roomId: string }> },
) {
  const { roomId } = await ctx.params;
  const service = await createServiceClient();

  const { data: room } = await service
    .from("live_rooms")
    .select("id, phase, current_market_id")
    .eq("id", roomId)
    .maybeSingle();
  if (!room) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const phase = (room as { phase: string }).phase;
  const marketId = (room as { current_market_id: string | null }).current_market_id;

  if (phase === "waiting_for_next_market") {
    const grid = await openCityGridMarketForRoom(roomId);
    if ("marketId" in grid && grid.marketId) {
      return NextResponse.json({
        action: "try_open_city_grid",
        marketId: grid.marketId,
      });
    }
    const r = await openSystemMarketForRoom(roomId);
    if ("marketId" in r && r.marketId) {
      return NextResponse.json({
        action: "try_open_market",
        cityGridSkippedReason: "error" in grid ? grid.error : null,
        ...r,
      });
    }
    // Neither city-grid nor turn market opened — try a provisional engine bet.
    const eng = await openEngineMarketForRoom(roomId);
    return NextResponse.json({
      action: "try_open_engine_market",
      cityGridSkippedReason: "error" in grid ? grid.error : null,
      systemSkippedReason: "error" in r ? r.error : null,
      ...eng,
    });
  }

  if ((phase === "market_open" || phase === "market_locked") && marketId) {
    const { data: market } = await service
      .from("live_betting_markets")
      .select(
        "id, status, locks_at, reveal_at, turn_point_lat, turn_point_lng, live_session_id, market_type",
      )
      .eq("id", marketId)
      .maybeSingle();
    if (!market) return NextResponse.json({ action: "no_market" });

    const now = Date.now();
    const locksAtStr = (market as { locks_at: string }).locks_at;
    const locksAt = new Date(locksAtStr).getTime();
    const revealAt = new Date((market as { reveal_at: string }).reveal_at).getTime();
    const status = (market as { status: string }).status;
    const marketType = (market as { market_type: string | null }).market_type ?? "";

    if (status === "open") {
      // Distance-based lock: vehicle within `LIVE_BET_LOCK_DISTANCE_M` of the
      // turn point closes betting. This is the primary trigger; the
      // time-based `locks_at` is a far-future safety net.
      let distanceLocked = false;
      const turnLat = (market as { turn_point_lat: number | null }).turn_point_lat;
      const turnLng = (market as { turn_point_lng: number | null }).turn_point_lng;
      const sessionId = (market as { live_session_id: string | null }).live_session_id;
      if (
        !liveBetRelaxServer() &&
        turnLat != null &&
        turnLng != null &&
        sessionId
      ) {
        const { data: latestGps } = await service
          .from("live_route_snapshots")
          .select("normalized_lat,normalized_lng,raw_lat,raw_lng")
          .eq("live_session_id", sessionId)
          .order("recorded_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (latestGps) {
          const gps = latestGps as {
            normalized_lat: number | null;
            normalized_lng: number | null;
            raw_lat: number;
            raw_lng: number;
          };
          const lat = gps.normalized_lat ?? gps.raw_lat;
          const lng = gps.normalized_lng ?? gps.raw_lng;
          const dist = metersBetween(
            { lat, lng },
            { lat: turnLat, lng: turnLng },
          );
          distanceLocked = dist <= LIVE_BET_LOCK_DISTANCE_M;
        }
      }
      if (distanceLocked || now >= locksAt) {
        const r = await lockMarket(marketId);
        return NextResponse.json({
          action: "lock",
          reason: distanceLocked ? "distance" : "timeout",
          ...r,
        });
      }
    }
    if (status === "locked") {
      if (isEngineMarketType(marketType)) {
        // Event-driven settlement: check natural condition for this bet type.
        const settle = await shouldSettleEngineMarket(service, {
          marketId,
          marketType,
          locksAt: locksAtStr,
          liveSessionId: (market as { live_session_id: string | null }).live_session_id,
          roomId,
        });
        if (settle) {
          const r = await revealAndSettleMarket(marketId);
          return NextResponse.json({ action: "engine_event_reveal", marketType, ...r });
        }
        return NextResponse.json({ action: "engine_waiting", marketType, phase });
      }
      if (now >= revealAt) {
        const r = await revealAndSettleMarket(marketId);
        return NextResponse.json({ action: "reveal", ...r });
      }
    }
  }

  return NextResponse.json({ action: "noop", phase });
}
