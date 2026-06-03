import {
  cellIdForPosition,
  parseGridOptionId,
  type CityGridSpecCompact,
} from "@/lib/live/grid/cityGrid500";
import { classifyEstimatedTimeOption } from "./classifyEstimatedTimeOption";
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
 * Rules (match option labels "< T", "= T", "> T"):
 * - Driver still in start cell after countdown → `exit_over`
 * - Driver still in start cell before countdown → refund (premature settle)
 * - Driver left before T sec → `exit_under`
 * - Driver left at ~T sec → `exit_at`
 * - Driver left after T sec → `exit_over`
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

  // Still in start cell — timer expired while inside, or premature settle (GPS flicker).
  if (!currentCellKey || currentCellKey === startCellKey) {
    if (!countdownElapsed) {
      console.log(`[zoneExitResolver] refund (still in zone, timer running)`, logCtx);
      return { outcome: "refund", reason: "zone_exit_still_in_zone_premature" };
    }
    const reason = `zone_exit_countdown_elapsed_est${estimatedSec}s`;
    console.log(`[zoneExitResolver] exit_over (still in zone)`, { ...logCtx, reason });
    return { outcome: "win", optionId: "exit_over", reason };
  }

  const exitAtMs = new Date(g.recorded_at).getTime();
  const elapsedSec =
    Number.isFinite(opensAtMs) && Number.isFinite(exitAtMs)
      ? Math.max(0, (exitAtMs - opensAtMs) / 1000)
      : Number.POSITIVE_INFINITY;

  const optionId = classifyEstimatedTimeOption(elapsedSec, estimatedSec, "exit");
  const reason = `zone_exit_${Math.round(elapsedSec)}s_est${estimatedSec}s`;

  console.log(`[zoneExitResolver] ${optionId}`, { ...logCtx, elapsedSec, reason });
  return { outcome: "win", optionId, reason };
}
