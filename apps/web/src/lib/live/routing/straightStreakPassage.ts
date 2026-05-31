import {
  STRAIGHT_STREAK_COMMITTED_TURN_DEG,
  STRAIGHT_THRESHOLD_DEG,
  STREAK_CROSSROAD_PROXIMITY_M,
} from "@/lib/live/betting/betWindowConstants";
import { metersBetween } from "@/lib/live/routing/geometry";
import type { CrossroadBearing } from "@/lib/live/routing/straightStreakAnalyzer";

export type GpsSample = {
  lat: number;
  lng: number;
  heading: number | null;
};

export type PassageResult = "straight" | "turn" | "not_reached";

export type StreakProgress = {
  straightCount: number;
  ended: boolean;
  endedReason: "turn" | "not_reached" | "complete" | null;
};

export function angleDeltaDeg(a: number, b: number): number {
  let d = b - a;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return Math.abs(d);
}

/**
 * Classify how the driver moved through one expected intersection using GPS
 * snapshots since market open.
 */
export function scoreIntersectionPassage(
  gps: GpsSample[],
  intersection: Pick<CrossroadBearing, "lat" | "lng">,
  proximityM = STREAK_CROSSROAD_PROXIMITY_M,
): PassageResult {
  const nearby = gps.filter(
    (p) =>
      metersBetween({ lat: p.lat, lng: p.lng }, intersection) <= proximityM,
  );

  if (nearby.length === 0) return "not_reached";

  const firstHeading = nearby.find((p) => p.heading != null)?.heading ?? null;
  const lastHeading = [...nearby].reverse().find((p) => p.heading != null)?.heading ?? null;

  if (firstHeading == null || lastHeading == null) {
    return "straight";
  }

  return angleDeltaDeg(firstHeading, lastHeading) < STRAIGHT_THRESHOLD_DEG
    ? "straight"
    : "turn";
}

/**
 * Walk expected intersections in route order. Stops at the first turn or gap.
 * Completes when `straightCount` reaches `expectedStreak`.
 */
export function countStraightStreakProgress(
  gps: GpsSample[],
  intersections: CrossroadBearing[],
  expectedStreak: number,
): StreakProgress {
  let straightCount = 0;

  for (const intersection of intersections) {
    const result = scoreIntersectionPassage(gps, intersection);
    if (result === "not_reached") {
      return { straightCount, ended: straightCount > 0, endedReason: "not_reached" };
    }
    if (result === "turn") {
      return { straightCount, ended: true, endedReason: "turn" };
    }
    straightCount++;
    if (straightCount >= expectedStreak) {
      return { straightCount, ended: true, endedReason: "complete" };
    }
  }

  return { straightCount, ended: false, endedReason: null };
}

/** True when overall heading change since the first valid sample indicates a turn. */
export function hasCommittedTurn(
  gps: GpsSample[],
  thresholdDeg = STRAIGHT_STREAK_COMMITTED_TURN_DEG,
): boolean {
  const headings = gps.map((p) => p.heading).filter((h): h is number => h != null);
  if (headings.length < 2) return false;
  return angleDeltaDeg(headings[0]!, headings[headings.length - 1]!) >= thresholdDeg;
}
