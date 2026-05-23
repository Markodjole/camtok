import { metersBetween } from "@/lib/live/routing/geometry";
import {
  STRAIGHT_THRESHOLD_DEG,
  STREAK_CROSSROAD_PROXIMITY_M,
} from "@/lib/live/betting/betWindowConstants";
import type { CrossroadBearing, StraightStreakSubtitle } from "@/lib/live/routing/straightStreakAnalyzer";
import type { MarketForResolution, MarketResolution, ServiceClient } from "./types";

// ─── Subtitle parsing ─────────────────────────────────────────────────────────

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

// ─── Heading delta helpers ─────────────────────────────────────────────────────

function angleDelta(a: number, b: number): number {
  let d = b - a;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return Math.abs(d);
}

// ─── Resolver ─────────────────────────────────────────────────────────────────

/**
 * Resolve a `straight_streak` market.
 *
 * For each expected intersection (stored in the market subtitle at open time),
 * we search GPS snapshots taken after `opens_at` to find points that passed
 * near the intersection.  The heading delta between entry and exit points
 * classifies the passage as "straight" (delta < STRAIGHT_THRESHOLD_DEG) or
 * "turn" (delta ≥ threshold).
 *
 * We count consecutive straight passages, stopping at the first turn.
 * The actual count is then compared to `expectedStreak` (with ±1 tolerance
 * for the "at" bucket) to determine the winning option.
 *
 * ±1 tolerance rationale
 * ──────────────────────
 * GPS sampling (~1 Hz) and normaliser lag mean the last GPS point before a
 * turn can sometimes be 30–40 m past the intersection centroid.  A one-count
 * slack prevents systematic mis-scoring near the bucket boundaries.
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

  // ── Load GPS snapshots since market open ───────────────────────────────────
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

  type Snap = {
    lat: number;
    lng: number;
    heading: number | null;
    recordedAt: string;
  };

  const gps: Snap[] = (snaps as Array<{
    recorded_at: string;
    normalized_lat: number | null;
    normalized_lng: number | null;
    raw_lat: number;
    raw_lng: number;
    heading_deg: number | null;
  }>).map((p) => ({
    lat: p.normalized_lat ?? p.raw_lat,
    lng: p.normalized_lng ?? p.raw_lng,
    heading: p.heading_deg,
    recordedAt: p.recorded_at,
  }));

  // ── Score each expected intersection ──────────────────────────────────────
  let actualStraights = 0;

  for (const intersection of intersections) {
    const result = scoreIntersectionPassage(gps, intersection);

    console.log(`[streakResolver] intersection ${intersection.nodeId}`, {
      marketId: market.id,
      result,
      expectedBearingChangeDeg: intersection.bearingChangeDeg,
    });

    if (result === "not_reached") {
      // Driver never got close enough — streak ended before this intersection.
      break;
    }
    if (result === "straight") {
      actualStraights++;
    } else {
      // result === "turn": streak ended here.
      break;
    }
  }

  // ── Classify result ────────────────────────────────────────────────────────
  // ±1 tolerance so GPS timing jitter doesn't mis-score boundary cases.
  const lo = expectedStreak - 1;
  const hi = expectedStreak + 1;
  const optionId =
    actualStraights < lo
      ? "streak_under"
      : actualStraights <= hi
        ? "streak_at"
        : "streak_over";

  const reason = `straight_streak_actual${actualStraights}_expected${expectedStreak}`;
  console.log(`[streakResolver] ${optionId}`, { marketId: market.id, actualStraights, expectedStreak, lo, hi });

  return { outcome: "win", optionId, reason };
}

// ─── Intersection passage scoring ────────────────────────────────────────────

type PassageResult = "straight" | "turn" | "not_reached";

/**
 * Determine how the driver moved through a single expected intersection.
 *
 * Strategy:
 *   1. Find all GPS snapshots within STREAK_CROSSROAD_PROXIMITY_M of the
 *      intersection centroid.
 *   2. If none: the driver hasn't reached this intersection yet → "not_reached".
 *   3. Otherwise, compare the heading of the first nearby point to the last
 *      nearby point.  Large delta = turn; small delta = straight.
 *   4. If heading data is absent for both boundary points, fall back to
 *      "straight" (benefit of the doubt — GPS heading is unreliable at low
 *      speeds, and we'd rather under-penalise than refund).
 */
function scoreIntersectionPassage(
  gps: Array<{ lat: number; lng: number; heading: number | null }>,
  intersection: CrossroadBearing,
): PassageResult {
  // Collect snapshots within the proximity radius.
  const nearby = gps.filter(
    (p) =>
      metersBetween({ lat: p.lat, lng: p.lng }, intersection) <=
      STREAK_CROSSROAD_PROXIMITY_M,
  );

  if (nearby.length === 0) return "not_reached";

  // Use the first and last nearby heading for a stable comparison.
  const firstHeading = nearby.find((p) => p.heading != null)?.heading ?? null;
  const lastHeading = [...nearby].reverse().find((p) => p.heading != null)?.heading ?? null;

  if (firstHeading == null || lastHeading == null) {
    // Not enough heading data — default to straight.
    return "straight";
  }

  const delta = angleDelta(firstHeading, lastHeading);
  return delta < STRAIGHT_THRESHOLD_DEG ? "straight" : "turn";
}
