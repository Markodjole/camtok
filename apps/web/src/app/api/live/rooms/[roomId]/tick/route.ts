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
  cellIdForPosition,
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
    /**
     * Throttle grid markets so the engine rotation (7 bet types) drives
     * most cycles. Grid markets now wait for an actual cell crossing to
     * settle accurately, which means each one can hold the room for tens of
     * seconds. Letting them fire every other market collapses viewer
     * variety back to grid-only. Open a grid round only when none of the
     * last 4 markets in this room were grid — engine fills the rest.
     */
    const { data: recentRows } = await service
      .from("live_betting_markets")
      .select("market_type")
      .eq("room_id", roomId)
      .order("opens_at", { ascending: false })
      .limit(4);
    const recentTypes = (recentRows ?? []).map(
      (r) => (r as { market_type?: string }).market_type ?? "",
    );
    const hasRecentGrid = recentTypes.includes("city_grid");
    const tryGridFirst = !hasRecentGrid;
    let cityGridSkippedReason: string | null = null;

    if (tryGridFirst) {
      const grid = await openCityGridMarketForRoom(roomId);
      if ("marketId" in grid && grid.marketId) {
        return NextResponse.json({
          action: "try_open_city_grid",
          marketId: grid.marketId,
        });
      }
      if ("error" in grid) cityGridSkippedReason = grid.error ?? null;
    }

    const eng = await openEngineMarketForRoom(roomId);
    if ("marketId" in eng && eng.marketId) {
      return NextResponse.json({
        action: "try_open_engine_market",
        cityGridSkippedReason,
        ...eng,
      });
    }

    if (!tryGridFirst) {
      // Engine path was unavailable for some reason — fall back to grid even
      // if one ran recently so the room never sits empty.
      const grid2 = await openCityGridMarketForRoom(roomId);
      if ("marketId" in grid2 && grid2.marketId) {
        return NextResponse.json({
          action: "try_open_city_grid",
          marketId: grid2.marketId,
        });
      }
      if ("error" in grid2) cityGridSkippedReason = grid2.error ?? null;
    }

    const r = await openSystemMarketForRoom(roomId);
    return NextResponse.json({
      action: "try_open_market",
      cityGridSkippedReason,
      engineSkippedReason: "error" in eng ? eng.error : null,
      ...r,
    });
  }

  if ((phase === "market_open" || phase === "market_locked") && marketId) {
    const { data: market } = await service
      .from("live_betting_markets")
      .select(
        "id, status, opens_at, locks_at, reveal_at, turn_point_lat, turn_point_lng, live_session_id, market_type, city_grid_spec, lock_evidence_json",
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
      /**
       * Hard upper-bound: nothing stays in `market_open` beyond ~13 s past
       * `opens_at`. Even if `locks_at` or the distance check don't fire we
       * force-lock so the cycle rolls and a new bet appears.
       */
      const HARD_OPEN_CAP_MS = 13_000;
      const overOpenCap =
        Number.isFinite(opensAtMs) && now - opensAtMs >= HARD_OPEN_CAP_MS;
      // Include city_grid so short `locks_at` (5s) can lock after min-open; edge
      // distance still locks earlier when the driver leaves the cell.
      const timeoutApplies = true;
      if (
        marketAgeOkForLock &&
        (distanceLocked || (timeoutApplies && now >= locksAt) || overOpenCap)
      ) {
        const r = await lockMarket(marketId);
        return NextResponse.json({
          action: "lock",
          reason: distanceLocked
            ? (distanceReason ?? "distance")
            : overOpenCap
              ? "hard_cap"
              : "timeout",
          ...r,
        });
      }
    }
    if (status === "locked") {
      /**
       * Hard upper-bound: most market types must not stay in `market_locked`
       * beyond ~3 s past `locks_at`. `city_grid` is the exception — its
       * settlement is tied to the driver actually crossing into a new cell,
       * so its `reveal_at` is much further out and we DO NOT apply this cap.
       */
      const HARD_LOCK_CAP_MS = 3_000;
      const lockedTooLong =
        Number.isFinite(locksAt) && now - locksAt >= HARD_LOCK_CAP_MS;
      if (isEngineMarketType(marketType)) {
        const settle = await shouldSettleEngineMarket(service, {
          marketId,
          marketType,
          locksAt: locksAtStr,
          liveSessionId: (market as { live_session_id: string | null }).live_session_id,
          roomId,
        });
        if (settle || lockedTooLong) {
          const r = await revealAndSettleMarket(marketId);
          return NextResponse.json({
            action: "engine_event_reveal",
            marketType,
            reason: settle ? "event" : "hard_cap",
            ...r,
          });
        }
        return NextResponse.json({ action: "engine_waiting", marketType, phase });
      }
      if (marketType === "city_grid") {
        /**
         * Wait until the driver actually enters a different grid cell, then
         * reveal — the winning option is whatever cell they're in at that
         * moment (resolved in `revealAndSettleMarket`). We pulled the
         * "starting" cell out of `lock_evidence_json.selectedOptionId`,
         * which `lockMarket` records as the cell the driver was sitting in
         * the instant betting closed. Falling back to the GPS-at-open
         * snapshot keeps this robust if evidence is missing for any reason.
         */
        const gridSpec = (market as { city_grid_spec: CityGridSpecCompact | null })
          .city_grid_spec;
        const sessionId = (market as { live_session_id: string | null })
          .live_session_id;
        let crossed = false;
        if (gridSpec && sessionId) {
          const lockEvidence = (market as {
            lock_evidence_json: { selectedOptionId?: string } | null;
          }).lock_evidence_json;
          let startCell: string | null =
            lockEvidence?.selectedOptionId ?? null;

          if (!startCell) {
            const { data: openGps } = await service
              .from("live_route_snapshots")
              .select(
                "normalized_lat,normalized_lng,raw_lat,raw_lng",
              )
              .eq("live_session_id", sessionId)
              .lte("recorded_at", opensAtStr)
              .order("recorded_at", { ascending: false })
              .limit(1)
              .maybeSingle();
            if (openGps) {
              const g = openGps as {
                normalized_lat: number | null;
                normalized_lng: number | null;
                raw_lat: number;
                raw_lng: number;
              };
              startCell = cellIdForPosition(
                gridSpec,
                g.normalized_lat ?? g.raw_lat,
                g.normalized_lng ?? g.raw_lng,
              );
            }
          }

          if (startCell) {
            const { data: latestGps } = await service
              .from("live_route_snapshots")
              .select(
                "normalized_lat,normalized_lng,raw_lat,raw_lng",
              )
              .eq("live_session_id", sessionId)
              .order("recorded_at", { ascending: false })
              .limit(1)
              .maybeSingle();
            if (latestGps) {
              const g = latestGps as {
                normalized_lat: number | null;
                normalized_lng: number | null;
                raw_lat: number;
                raw_lng: number;
              };
              const currentCell = cellIdForPosition(
                gridSpec,
                g.normalized_lat ?? g.raw_lat,
                g.normalized_lng ?? g.raw_lng,
              );
              if (currentCell && currentCell !== startCell) crossed = true;
            }
          }
        }

        if (crossed) {
          const r = await revealAndSettleMarket(marketId);
          return NextResponse.json({
            action: "grid_cell_crossed_reveal",
            ...r,
          });
        }
        if (now >= revealAt) {
          const r = await revealAndSettleMarket(marketId);
          return NextResponse.json({
            action: "grid_timeout_reveal",
            ...r,
          });
        }
        return NextResponse.json({
          action: "grid_awaiting_cell_cross",
          phase,
        });
      }
      if (now >= revealAt || lockedTooLong) {
        const r = await revealAndSettleMarket(marketId);
        return NextResponse.json({ action: "reveal", ...r });
      }
    }
  }

  return NextResponse.json({ action: "noop", phase });
}
