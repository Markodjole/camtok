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
import { MIN_MARKET_OPEN_MS_BEFORE_LOCK } from "@/lib/live/liveBetMinOpenMs";
import { metersBetween } from "@/lib/live/routing/geometry";
import { isEngineMarketType } from "@/lib/live/betting/engineMarketOptions";
import { computeDriverRouteInstruction } from "@/lib/live/routing/computeDriverRouteInstruction";
import {
  distanceToCurrentCellEdgeMeters,
  type CityGridSpecCompact,
} from "@/lib/live/grid/cityGrid500";

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
    // Prefer engine markets before system turn-markets so viewers see all bet
    // types in a short driving span.
    const eng = await openEngineMarketForRoom(roomId);
    if ("marketId" in eng && eng.marketId) {
      return NextResponse.json({
        action: "try_open_engine_market",
        cityGridSkippedReason: "error" in grid ? grid.error : null,
        ...eng,
      });
    }
    // Fallback to system (turn) market.
    const r = await openSystemMarketForRoom(roomId);
    return NextResponse.json({
      action: "try_open_market",
      cityGridSkippedReason: "error" in grid ? grid.error : null,
      engineSkippedReason: "error" in eng ? eng.error : null,
      ...r,
    });
  }

  if ((phase === "market_open" || phase === "market_locked") && marketId) {
    const { data: market } = await service
      .from("live_betting_markets")
      .select(
        "id, status, opens_at, locks_at, reveal_at, turn_point_lat, turn_point_lng, live_session_id, market_type, city_grid_spec",
      )
      .eq("id", marketId)
      .maybeSingle();
    if (!market) return NextResponse.json({ action: "no_market" });

    const now = Date.now();
    const opensAtStr = (market as { opens_at: string }).opens_at;
    const opensAtMs = Date.parse(opensAtStr);
    const locksAtStr = (market as { locks_at: string }).locks_at;
    const locksAt = new Date(locksAtStr).getTime();
    const revealAt = new Date((market as { reveal_at: string }).reveal_at).getTime();
    const minLockEligibleAt =
      Number.isFinite(opensAtMs) ? opensAtMs + MIN_MARKET_OPEN_MS_BEFORE_LOCK : 0;
    const marketAgeOkForLock =
      !Number.isFinite(opensAtMs) || now >= minLockEligibleAt;
    const status = (market as { status: string }).status;
    const marketType = (market as { market_type: string | null }).market_type ?? "";

    if (status === "open") {
      // Per-bet lock thresholds:
      // - next_turn (turn-point markets): <=70 m to turn
      // - time_vs_google: <=160 m to next pin
      // - next_zone (city_grid): <=60 m to current-cell edge
      let distanceLocked = false;
      let distanceReason: "turn_100m" | "pin_220m" | "zone_edge_100m" | null = null;
      const turnLat = (market as { turn_point_lat: number | null }).turn_point_lat;
      const turnLng = (market as { turn_point_lng: number | null }).turn_point_lng;
      const sessionId = (market as { live_session_id: string | null }).live_session_id;
      if (marketAgeOkForLock && !liveBetRelaxServer() && sessionId) {
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

          if (marketType === "time_vs_google") {
            const drv = await computeDriverRouteInstruction(roomId);
            const pinDist = drv.instruction?.pins?.[0]?.distanceMeters ?? null;
            if (pinDist != null && pinDist <= 160) {
              distanceLocked = true;
              distanceReason = "pin_220m";
            }
          } else if (marketType === "city_grid") {
            const gridSpec = (market as { city_grid_spec: CityGridSpecCompact | null })
              .city_grid_spec;
            if (gridSpec) {
              const edgeM = distanceToCurrentCellEdgeMeters(gridSpec, lat, lng);
              if (edgeM != null && edgeM <= 60) {
                distanceLocked = true;
                distanceReason = "zone_edge_100m";
              }
            }
          } else if (turnLat != null && turnLng != null) {
            const dist = metersBetween({ lat, lng }, { lat: turnLat, lng: turnLng });
            if (dist <= 70) {
              distanceLocked = true;
              distanceReason = "turn_100m";
            }
          }
        }
      }
      const timeoutApplies =
        marketType !== "city_grid" && !isEngineMarketType(marketType);
      if (
        marketAgeOkForLock &&
        (distanceLocked || (timeoutApplies && now >= locksAt))
      ) {
        const r = await lockMarket(marketId);
        return NextResponse.json({
          action: "lock",
          reason: distanceLocked ? (distanceReason ?? "distance") : "timeout",
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
