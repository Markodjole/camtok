/**
 * Straight-streak analysis: given a planning polyline and the ordered list of
 * upcoming crossroads (pins), determine how many of them the planned route
 * passes through "straight" — i.e., with a small bearing change at the
 * intersection point — before making a genuine turn.
 *
 * This is the foundation for the `straight_streak` bet type:
 *   "How many consecutive straight-through intersections before the next turn?"
 *
 * Architecture note
 * -----------------
 * We purposely use the **existing OSM crossroad pipeline** (pins from
 * `computeDriverRouteInstruction`) rather than OSRM step maneuvers, because:
 *   - The crossroads are already filtered for "bettable" intersections
 *     (≥2 meaningful drivable branches, no tracks/footways/private roads).
 *   - The planning polyline (Google or OSRM) tells us exactly what the route
 *     does at each crossroad — the bearing change there is the ground truth.
 *   - We avoid adding a new `steps=true` OSRM fetch (latency + quota).
 */

import {
  bearingDegrees,
  metersBetween,
  projectOntoPolyline,
  type LatLng,
} from "@/lib/live/routing/geometry";
import {
  STRAIGHT_THRESHOLD_DEG,
  STRAIGHT_STREAK_MIN_LENGTH,
} from "@/lib/live/betting/betWindowConstants";

// ─── Types ────────────────────────────────────────────────────────────────────

/** A single crossroad annotated with the bearing change of the planned route. */
export type CrossroadBearing = {
  /** OSM node id — stable identifier for de-dupe and resolver proximity. */
  nodeId: number;
  lat: number;
  lng: number;
  /** Road-distance from the vehicle when the analysis was computed (meters). */
  distanceMeters: number;
  /**
   * Absolute bearing change (degrees) of the planning polyline at this
   * crossroad.  0° = perfectly straight; 90° = right-angle turn.
   * Computed from the incoming and outgoing segments nearest the crossroad.
   */
  bearingChangeDeg: number;
  /** `true` when `bearingChangeDeg < STRAIGHT_THRESHOLD_DEG`. */
  isStraight: boolean;
};

export type StreakAnalysis = {
  /** All upcoming crossroads with their route bearing changes. */
  crossroads: CrossroadBearing[];
  /**
   * Count of consecutive "straight" crossroads from index 0 before the first
   * genuine turn (or end of the crossroad list).
   */
  streakLength: number;
  /**
   * Stable de-dupe key for this straight sequence, based on the first
   * crossroad's OSM node id.  `null` when `streakLength < MIN_LENGTH`.
   */
  streakKey: string | null;
};

/**
 * JSON schema stored in `live_betting_markets.subtitle` for `straight_streak`
 * markets.  Parsed by `straightStreakResolver` at settlement time.
 */
export type StraightStreakSubtitle = {
  expectedStreak: number;
  streakKey: string;
  /**
   * All crossroads the client tracker should count.
   *
   * Populated at market-open time from one of two sources:
   *   - Sparse OSM pins (fallback): 3–4 "bettable" intersections from
   *     `computeDriverRouteInstruction`, 200–400 m apart.
   *   - Dense OSRM junctions (preferred): all real road junctions
   *     (bearings.length ≥ 3) extracted from OSRM step `intersections`,
   *     typically 10–30+ entries per km.  `bearingChangeDeg` and `isStraight`
   *     are synthetic (0 / true) for this source — the resolver scores each
   *     junction from actual GPS headings at settlement time.
   */
  intersections: CrossroadBearing[];
};

// ─── Core computation ─────────────────────────────────────────────────────────

/**
 * Compute the absolute bearing change of the planning polyline at `point`.
 *
 * Algorithm:
 *   1. Project `point` onto the polyline to find the nearest segment.
 *   2. "Approach bearing" = direction of that segment.
 *   3. "Departure bearing" = direction of the following segment.
 *   4. Return the absolute angular difference (0–180 °).
 *
 * Returns 0 when data is insufficient (too few points, near route end, etc.)
 * — callers treat that as "straight" for conservative classification.
 */
export function computeBearingChangeAtPoint(
  polyline: LatLng[],
  point: LatLng,
): number {
  if (polyline.length < 3) return 0;

  const proj = projectOntoPolyline(polyline, point);
  if (!proj) return 0;

  const approachIdx = proj.segmentIndex;
  const departureIdx = approachIdx + 1;

  // Need at least two segments after the projection point.
  if (departureIdx >= polyline.length - 1) return 0;

  const p0 = polyline[approachIdx]!;
  const p1 = polyline[approachIdx + 1]!;
  const p2 = polyline[departureIdx + 1]!;

  // Segments shorter than 5 m are GPS noise — skip.
  if (metersBetween(p0, p1) < 5 || metersBetween(p1, p2) < 5) return 0;

  const bearingIn = bearingDegrees(p0, p1);
  const bearingOut = bearingDegrees(p1, p2);

  // Normalise to 0–180 °.
  return Math.abs(((bearingOut - bearingIn + 540) % 360) - 180);
}

/**
 * Analyse the straight streak ahead of the vehicle.
 *
 * Walks the ordered pin list from closest to farthest, classifies each
 * crossroad as "straight" or "turn" based on the planning polyline, and
 * counts the unbroken leading run of straight crossroads.
 */
export function analyzeStreakAhead(
  planningPolyline: LatLng[],
  pins: Array<{ id: number; lat: number; lng: number; distanceMeters: number }>,
): StreakAnalysis {
  const crossroads: CrossroadBearing[] = pins.map((pin) => {
    const bearingChangeDeg = computeBearingChangeAtPoint(planningPolyline, pin);
    return {
      nodeId: pin.id,
      lat: pin.lat,
      lng: pin.lng,
      distanceMeters: pin.distanceMeters,
      bearingChangeDeg,
      isStraight: bearingChangeDeg < STRAIGHT_THRESHOLD_DEG,
    };
  });

  // Count consecutive straights from the front.
  let streakLength = 0;
  for (const c of crossroads) {
    if (!c.isStraight) break;
    streakLength++;
  }

  const streakKey =
    streakLength >= STRAIGHT_STREAK_MIN_LENGTH && crossroads[0]
      ? `streak:${crossroads[0].nodeId}`
      : null;

  return { crossroads, streakLength, streakKey };
}
