/**
 * GET /api/live/market-debug/[marketId]
 *
 * Returns a full diagnostic snapshot for a single betting market:
 *   - Current DB row (status, timestamps, market_type)
 *   - Latest GPS snapshot (position, age, staleness flag)
 *   - Live re-run of every settlement condition (same logic the sweep uses)
 *   - Recent sweep log entries (in-process ring buffer)
 *   - Human-readable "reason not settled yet" explanation
 *
 * Use this endpoint whenever a countdown stops and settlement seems stuck.
 * It is read-only and has no side-effects.
 */

import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { shouldSettleEngineMarket } from "@/actions/live-engine-market";
import { isEngineMarketType } from "@/lib/live/betting/engineMarketOptions";
import { getMarketSweepLog } from "@/lib/live/tick/runRoomTick";
import {
  cellIdForPosition,
  parseGridOptionId,
  type CityGridSpecCompact,
} from "@/lib/live/grid/cityGrid500";
import { STRAIGHT_STREAK_COMMITTED_TURN_DEG } from "@/lib/live/betting/betWindowConstants";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function angleDeltaDeg(a: number, b: number): number {
  let d = b - a;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return Math.abs(d);
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ marketId: string }> },
) {
  const { marketId } = await params;
  const service = await createServiceClient();
  const nowMs = Date.now();

  // ── 1. Fetch market row ──────────────────────────────────────────────────
  const { data: market } = await service
    .from("live_betting_markets")
    .select(
      "id, room_id, live_session_id, status, market_type, opens_at, locks_at, reveal_at, subtitle, city_grid_spec, turn_point_lat, turn_point_lng",
    )
    .eq("id", marketId)
    .maybeSingle();

  if (!market) {
    return NextResponse.json({ error: "market_not_found" }, { status: 404 });
  }

  const m = market as {
    id: string;
    room_id: string;
    live_session_id: string | null;
    status: string;
    market_type: string;
    opens_at: string;
    locks_at: string;
    reveal_at: string;
    subtitle: string | null;
    city_grid_spec: CityGridSpecCompact | null;
    turn_point_lat: number | null;
    turn_point_lng: number | null;
  };

  const opensAtMs = new Date(m.opens_at).getTime();
  const locksAtMs = new Date(m.locks_at).getTime();
  const revealAtMs = new Date(m.reveal_at).getTime();

  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(m.subtitle ?? "{}") as Record<string, unknown>;
  } catch { /* ignore */ }

  // ── 2. Timing analysis ──────────────────────────────────────────────────
  const timing = {
    opensAgo_s: Math.round((nowMs - opensAtMs) / 1000),
    locksAgo_s: Math.round((nowMs - locksAtMs) / 1000),
    revealIn_s: Math.round((revealAtMs - nowMs) / 1000),
    locksAtPassed: nowMs >= locksAtMs,
    revealAtPassed: nowMs >= revealAtMs,
  };

  // ── 3. GPS analysis ──────────────────────────────────────────────────────
  let gpsInfo: Record<string, unknown> = { available: false };
  let gpsPoints: Array<{ lat: number; lng: number; heading: number | null; ts: string }> = [];

  if (m.live_session_id) {
    const { data: gpsRows } = await service
      .from("live_route_snapshots")
      .select("recorded_at, normalized_lat, normalized_lng, raw_lat, raw_lng, heading_deg")
      .eq("live_session_id", m.live_session_id)
      .gte("recorded_at", m.opens_at)
      .order("recorded_at", { ascending: true })
      .limit(100);

    if (gpsRows && gpsRows.length > 0) {
      const latest = gpsRows[gpsRows.length - 1] as {
        recorded_at: string;
        normalized_lat: number | null;
        normalized_lng: number | null;
        raw_lat: number;
        raw_lng: number;
        heading_deg: number | null;
      };
      const latestMs = new Date(latest.recorded_at).getTime();
      gpsInfo = {
        available: true,
        pointsSinceOpen: gpsRows.length,
        latestAt: latest.recorded_at,
        latestAge_s: Math.round((nowMs - latestMs) / 1000),
        stale: nowMs - latestMs > 30_000,
        lat: latest.normalized_lat ?? latest.raw_lat,
        lng: latest.normalized_lng ?? latest.raw_lng,
        heading_deg: latest.heading_deg,
      };
      gpsPoints = (gpsRows as typeof gpsRows).map((p) => {
        const px = p as typeof latest;
        return {
          lat: px.normalized_lat ?? px.raw_lat,
          lng: px.normalized_lng ?? px.raw_lng,
          heading: px.heading_deg,
          ts: px.recorded_at,
        };
      });
    }
  }

  // ── 4. Settlement condition checks ──────────────────────────────────────
  const checks: Record<string, unknown> = {};

  if (timing.revealAtPassed) {
    checks.reveal_at = { pass: true, detail: `reveal_at passed ${Math.abs(timing.revealIn_s)}s ago` };
  }

  if (m.market_type === "zone_exit_time" && m.live_session_id) {
    try {
      const result = await shouldSettleEngineMarket(service, {
        marketId,
        marketType: m.market_type,
        locksAt: m.locks_at,
        liveSessionId: m.live_session_id,
        roomId: m.room_id,
      });
      const estimatedSec = typeof meta.estimatedSec === "number" ? meta.estimatedSec : null;
      const countdownEndMs = estimatedSec != null ? opensAtMs + estimatedSec * 1000 : null;
      const countdownElapsed = countdownEndMs != null && nowMs >= countdownEndMs;
      const startCellKey = typeof meta.cellKey === "string" ? meta.cellKey : null;

      let currentCellKey: string | null = null;
      if (m.city_grid_spec && gpsPoints.length > 0) {
        const last = gpsPoints[gpsPoints.length - 1]!;
        const cellId = cellIdForPosition(m.city_grid_spec, last.lat, last.lng);
        if (cellId) {
          const parsed = parseGridOptionId(cellId);
          if (parsed) currentCellKey = `cell:r${parsed.row}:c${parsed.col}`;
        }
      }

      checks.zone_exit_time = {
        pass: result,
        estimatedSec,
        countdownElapsed,
        countdownEndsIn_s: countdownEndMs != null ? Math.round((countdownEndMs - nowMs) / 1000) : null,
        startCellKey,
        currentCellKey,
        driverLeftZone: currentCellKey != null && currentCellKey !== startCellKey,
        detail: result ? "should settle NOW" : !countdownElapsed ? `countdown ends in ${Math.round(((countdownEndMs ?? 0) - nowMs) / 1000)}s` : "driver still in zone, waiting for GPS exit",
      };
    } catch (err) {
      checks.zone_exit_time = { error: err instanceof Error ? err.message : String(err) };
    }
  }

  if (m.market_type === "straight_streak") {
    const headings = gpsPoints.map((p) => p.heading).filter((h): h is number => h != null);
    const firstH = headings[0] ?? null;
    const lastH = headings[headings.length - 1] ?? null;
    const totalDelta = firstH != null && lastH != null ? angleDeltaDeg(firstH, lastH) : null;
    const committed = totalDelta != null && totalDelta >= STRAIGHT_STREAK_COMMITTED_TURN_DEG;
    checks.straight_streak = {
      pass: committed,
      gpsPointsSinceOpen: gpsPoints.length,
      firstHeading: firstH,
      lastHeading: lastH,
      totalHeadingDelta: totalDelta,
      thresholdDeg: STRAIGHT_STREAK_COMMITTED_TURN_DEG,
      revealIn_s: timing.revealIn_s,
      detail: committed
        ? "heading change detected — should settle NOW"
        : totalDelta != null
          ? `heading delta ${Math.round(totalDelta)}° < ${STRAIGHT_STREAK_COMMITTED_TURN_DEG}° threshold — waiting for turn or reveal_at in ${timing.revealIn_s}s`
          : `no heading data yet (${gpsPoints.length} GPS points)`,
    };
  }

  if (m.market_type === "next_turn" && m.live_session_id) {
    const headings = gpsPoints.map((p) => p.heading).filter((h): h is number => h != null);
    const firstH = headings[0] ?? null;
    const lastH = headings[headings.length - 1] ?? null;
    const delta = firstH != null && lastH != null ? angleDeltaDeg(firstH, lastH) : null;
    checks.next_turn = {
      pass: delta != null && delta >= 50,
      headingDelta: delta,
      thresholdDeg: 50,
      detail: delta != null ? `heading delta ${Math.round(delta)}°` : "no heading data",
    };
  }

  // ── 5. Explain why not settled ──────────────────────────────────────────
  let blockedReason = "unknown";
  if (m.status === "resolved" || m.status === "settled") {
    blockedReason = "already_settled";
  } else if (m.status === "open" && !timing.locksAtPassed) {
    blockedReason = `betting_still_open_${timing.locksAgo_s < 0 ? `${Math.abs(timing.locksAgo_s)}s_remaining` : "just_closed"}`;
  } else if (timing.revealAtPassed) {
    blockedReason = "reveal_at_passed_tick_may_not_have_run_yet";
  } else {
    const check = checks[m.market_type] as { pass?: boolean; detail?: string } | undefined;
    if (check?.pass) {
      blockedReason = "condition_met_but_tick_hasnt_run_yet";
    } else if (check) {
      blockedReason = `waiting: ${check.detail ?? "condition not met"}`;
    } else {
      blockedReason = `no_check_implemented_for_${m.market_type}`;
    }
  }

  // ── 6. Sweep log ─────────────────────────────────────────────────────────
  const sweepLog = getMarketSweepLog(marketId);

  return NextResponse.json({
    marketId,
    marketType: m.market_type,
    roomId: m.room_id,
    status: m.status,
    timing,
    meta,
    gps: gpsInfo,
    checks,
    blockedReason,
    sweepLog,
    _generatedAt: new Date().toISOString(),
  });
}
