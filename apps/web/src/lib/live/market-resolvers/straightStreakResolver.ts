import type { StraightStreakSubtitle } from "@/lib/live/routing/straightStreakAnalyzer";
import {
  scoreIntersectionPassage,
  type GpsSample,
} from "@/lib/live/routing/straightStreakPassage";
import type { MarketForResolution, MarketResolution, ServiceClient } from "./types";

function parseStreakSubtitle(subtitle: string | null): StraightStreakSubtitle | null {
  try {
    const meta = JSON.parse(subtitle ?? "{}") as Partial<StraightStreakSubtitle>;
    if (
      typeof meta.expectedStreak === "number" &&
      typeof meta.streakKey === "string" &&
      Array.isArray(meta.intersections)
    ) {
      return meta as StraightStreakSubtitle;
    }
  } catch {
    // malformed subtitle
  }
  return null;
}

/**
 * Resolve a `straight_streak` market.
 *
 * Counts consecutive straight passages, stopping at the first turn.
 */
export async function straightStreakResolver(
  market: MarketForResolution,
  service: ServiceClient,
): Promise<MarketResolution> {
  const meta = parseStreakSubtitle(market.subtitle);
  if (!meta) {
    return { outcome: "refund", reason: "streak_missing_subtitle" };
  }

  const { expectedStreak, intersections } = meta;
  if (intersections.length === 0) {
    return { outcome: "refund", reason: "streak_no_intersections" };
  }

  const { data: snaps } = await service
    .from("live_route_snapshots")
    .select(
      "recorded_at, normalized_lat, normalized_lng, raw_lat, raw_lng, heading_deg",
    )
    .eq("live_session_id", market.live_session_id)
    .gte("recorded_at", market.opens_at)
    .order("recorded_at", { ascending: true })
    .limit(300);

  if (!snaps || snaps.length < 2) {
    return { outcome: "refund", reason: "streak_no_gps" };
  }

  const gps: GpsSample[] = (snaps as Array<{
    normalized_lat: number | null;
    normalized_lng: number | null;
    raw_lat: number;
    raw_lng: number;
    heading_deg: number | null;
  }>).map((p) => ({
    lat: p.normalized_lat ?? p.raw_lat,
    lng: p.normalized_lng ?? p.raw_lng,
    heading: p.heading_deg,
  }));

  let actualStraights = 0;

  for (const intersection of intersections) {
    const result = scoreIntersectionPassage(gps, intersection);

    console.log(`[streakResolver] intersection ${intersection.nodeId}`, {
      marketId: market.id,
      result,
      expectedBearingChangeDeg: intersection.bearingChangeDeg,
    });

    if (result === "not_reached") break;
    if (result === "straight") {
      actualStraights++;
    } else {
      break;
    }
  }

  const lo = expectedStreak - 1;
  const hi = expectedStreak + 1;
  const optionId =
    actualStraights < lo
      ? "streak_under"
      : actualStraights <= hi
        ? "streak_at"
        : "streak_over";

  const reason = `straight_streak_actual${actualStraights}_expected${expectedStreak}`;
  console.log(`[streakResolver] ${optionId}`, {
    marketId: market.id,
    actualStraights,
    expectedStreak,
    lo,
    hi,
  });

  return { outcome: "win", optionId, reason };
}
