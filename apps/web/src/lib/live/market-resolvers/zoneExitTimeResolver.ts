import {
  cellIdForPosition,
  parseGridOptionId,
  type CityGridSpecCompact,
} from "@/lib/live/grid/cityGrid500";
import type { MarketForResolution, MarketResolution, ServiceClient } from "./types";

interface ZoneExitMeta {
  cellKey: string;
  estimatedSec: number;
}

function parseZoneExitMeta(subtitle: string | null): ZoneExitMeta | null {
  try {
    const meta = JSON.parse(subtitle ?? "{}") as {
      cellKey?: string;
      estimatedSec?: number;
    };
    if (typeof meta.cellKey === "string") {
      return {
        cellKey: meta.cellKey,
        estimatedSec: typeof meta.estimatedSec === "number" ? meta.estimatedSec : 60,
      };
    }
  } catch {
    // malformed subtitle
  }
  return null;
}

/**
 * Resolve a `zone_exit_time` market.
 *
 * Rules:
 * - Driver still in start cell  → `exit_over` (countdown clearly elapsed)
 * - Driver left within < 80% T  → `exit_under`
 * - Driver left within 80–120% T → `exit_at`
 * - Driver left after > 120% T  → `exit_over`
 *
 * The ±20% window accounts for GPS polling latency and normalizer lag.
 */
export async function zoneExitTimeResolver(
  market: MarketForResolution,
  service: ServiceClient,
): Promise<MarketResolution> {
  const gridSpec = market.city_grid_spec as CityGridSpecCompact | null;
  if (!gridSpec) return { outcome: "refund", reason: "zone_exit_no_spec" };

  const meta = parseZoneExitMeta(market.subtitle);
  if (!meta) return { outcome: "refund", reason: "zone_exit_missing_start_cell" };

  const { cellKey: startCellKey, estimatedSec } = meta;

  const { data: latestGps } = await service
    .from("live_route_snapshots")
    .select("recorded_at, normalized_lat, normalized_lng, raw_lat, raw_lng")
    .eq("live_session_id", market.live_session_id)
    .order("recorded_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!latestGps) return { outcome: "refund", reason: "zone_exit_no_gps" };

  const g = latestGps as {
    recorded_at: string;
    normalized_lat: number | null;
    normalized_lng: number | null;
    raw_lat: number;
    raw_lng: number;
  };

  const currentCellId = cellIdForPosition(
    gridSpec,
    g.normalized_lat ?? g.raw_lat,
    g.normalized_lng ?? g.raw_lng,
  );
  const currentCell = currentCellId ? parseGridOptionId(currentCellId) : null;
  const currentCellKey =
    currentCell != null ? `cell:r${currentCell.row}:c${currentCell.col}` : null;

  const opensAtMs = new Date(market.opens_at).getTime();
  const countdownElapsed =
    Number.isFinite(opensAtMs) && Date.now() >= opensAtMs + estimatedSec * 1000;

  const logCtx = {
    marketId: market.id,
    startCellKey,
    currentCellKey,
    estimatedSec,
    opensAt: market.opens_at,
    latestGpsAt: g.recorded_at,
    countdownElapsed,
  };

  // Still in start cell — driver took too long or timer expired while they were inside.
  if (!currentCellKey || currentCellKey === startCellKey) {
    const reason = countdownElapsed
      ? `zone_exit_countdown_elapsed_est${estimatedSec}s`
      : `zone_exit_reveal_at_still_in_zone_est${estimatedSec}s`;
    console.log(`[zoneExitResolver] exit_over (still in zone)`, { ...logCtx, reason });
    return { outcome: "win", optionId: "exit_over", reason };
  }

  const exitAtMs = new Date(g.recorded_at).getTime();
  const elapsedSec =
    Number.isFinite(opensAtMs) && Number.isFinite(exitAtMs)
      ? Math.max(0, (exitAtMs - opensAtMs) / 1000)
      : Number.POSITIVE_INFINITY;

  // ±20% tolerance window around the estimate.
  const lo = estimatedSec * 0.8;
  const hi = estimatedSec * 1.2;
  const optionId =
    elapsedSec < lo ? "exit_under" : elapsedSec <= hi ? "exit_at" : "exit_over";
  const reason = `zone_exit_${Math.round(elapsedSec)}s_est${estimatedSec}s`;

  console.log(`[zoneExitResolver] ${optionId}`, { ...logCtx, elapsedSec, lo, hi, reason });
  return { outcome: "win", optionId, reason };
}
