import {
  cellIdForPosition,
  parseGridOptionId,
  type CityGridSpecCompact,
} from "@/lib/live/grid/cityGrid500";
import type { MarketForResolution, MarketResolution, ServiceClient } from "./types";

function parseStartCell(subtitle: string | null): { startRow: number; startCol: number } | null {
  try {
    const meta = JSON.parse(subtitle ?? "{}") as { startRow?: number; startCol?: number };
    if (typeof meta.startRow === "number" && typeof meta.startCol === "number") {
      return { startRow: meta.startRow, startCol: meta.startCol };
    }
  } catch {
    // malformed subtitle — treat as unknown start cell
  }
  return null;
}

/**
 * Resolve a `city_grid` (next_zone) market.
 *
 * Winning option is the grid cell the driver is **currently in**, as long as
 * it differs from the start cell captured at market open time. If the driver
 * is still inside the start cell (e.g. `reveal_at` timeout hit before they
 * moved), all stakes are refunded.
 */
export async function cityGridResolver(
  market: MarketForResolution,
  service: ServiceClient,
): Promise<MarketResolution> {
  const gridSpec = market.city_grid_spec as CityGridSpecCompact | null;
  if (!gridSpec) return { outcome: "refund", reason: "city_grid_no_spec" };

  const startCell = parseStartCell(market.subtitle);

  const { data: latestGps } = await service
    .from("live_route_snapshots")
    .select("normalized_lat, normalized_lng, raw_lat, raw_lng")
    .eq("live_session_id", market.live_session_id)
    .order("recorded_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!latestGps) return { outcome: "refund", reason: "city_grid_no_gps" };

  const g = latestGps as {
    normalized_lat: number | null;
    normalized_lng: number | null;
    raw_lat: number;
    raw_lng: number;
  };
  const lat = g.normalized_lat ?? g.raw_lat;
  const lng = g.normalized_lng ?? g.raw_lng;

  const currCellId = cellIdForPosition(gridSpec, lat, lng);
  if (!currCellId) return { outcome: "refund", reason: "city_grid_outside_cells" };

  const curr = parseGridOptionId(currCellId);
  if (!curr) return { outcome: "refund", reason: "city_grid_bad_cell_id" };

  if (
    startCell != null &&
    curr.row === startCell.startRow &&
    curr.col === startCell.startCol
  ) {
    return { outcome: "refund", reason: "city_grid_still_in_zone" };
  }

  return { outcome: "win", optionId: currCellId, reason: "gps_cell_enter" };
}
