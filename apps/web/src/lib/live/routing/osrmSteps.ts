/**
 * OSRM route with turn-by-turn steps.
 *
 * Extends the basic OSRM route fetch (`osrm.ts`) by requesting `steps=true`
 * so each leg is broken into individual maneuver steps with their exact
 * location, bearing, and turn type.  The `next_step` bet type uses these
 * step maneuver points as bet targets.
 */

import type { LatLng } from "./geometry";

// ─── Types ─────────────────────────────────────────────────────────────────

/**
 * A single road junction along an OSRM step (from the `intersections` array).
 * Every junction the vehicle passes while driving a step is listed here —
 * including minor side-street T-junctions, not just the final maneuver point.
 */
export type OsrmStepIntersection = {
  /** Exact lat/lng of this junction on the road network. */
  location: LatLng;
  /**
   * All road bearings at this junction (degrees, 0–360).
   * Length ≥ 3 means a real side-road junction (T or 4-way).
   * Length = 2 means a simple road continuation (curve/rename only).
   */
  bearings: number[];
  /**
   * Whether each bearing is a valid entry direction.
   * Parallel to `bearings`.
   */
  entry: boolean[];
};

/**
 * A single OSRM driving step between two consecutive maneuvers.
 *
 * `maneuver.type` values (non-exhaustive):
 *   "depart" | "arrive" | "turn" | "new name" | "continue" |
 *   "merge" | "on ramp" | "off ramp" | "fork" | "end of road" |
 *   "roundabout" | "roundabout turn" | "exit roundabout"
 *
 * `maneuver.modifier` values (non-exhaustive):
 *   "left" | "slight left" | "sharp left" |
 *   "right" | "slight right" | "sharp right" |
 *   "straight" | "uturn"
 */
export type OsrmStep = {
  /** Route distance of this step (meters). */
  distanceMeters: number;
  /** Estimated driving duration of this step (seconds). */
  durationSec: number;
  /** Road name for this step (empty string when unnamed). */
  name: string;
  maneuver: {
    /**
     * Type of maneuver at the END of this step (= start of the next one).
     * "depart" is the first step, "arrive" is the last.
     */
    type: string;
    /** Turn direction, absent for straight-through maneuvers. */
    modifier?: string;
    /** Exact lat/lng of the maneuver point. */
    location: LatLng;
    /** Heading (degrees, 0–360) immediately before the maneuver. */
    bearingBefore: number;
    /** Heading (degrees, 0–360) immediately after the maneuver. */
    bearingAfter: number;
  };
  /**
   * All road junctions the vehicle passes during this step, in traversal order.
   * The first entry is the step start, the last is the maneuver point itself.
   * Use these to get a dense list of every crossroad along the route.
   */
  intersections: OsrmStepIntersection[];
};

export type OsrmStepsResult = {
  polyline: LatLng[];
  distanceMeters: number;
  durationSec: number;
  steps: OsrmStep[];
};

// ─── Raw OSRM response shapes ───────────────────────────────────────────────

type RawManeuver = {
  type: string;
  modifier?: string;
  location: [number, number]; // [lng, lat]
  bearing_before: number;
  bearing_after: number;
};

type RawIntersection = {
  location: [number, number]; // [lng, lat]
  bearings: number[];
  entry: boolean[];
};

type RawStep = {
  distance: number;
  duration: number;
  name: string;
  maneuver: RawManeuver;
  intersections?: RawIntersection[];
};

type RawLeg = {
  steps: RawStep[];
};

type RawRoute = {
  distance: number;
  duration: number;
  geometry: { type: "LineString"; coordinates: Array<[number, number]> };
  legs: RawLeg[];
};

type RawOsrmResponse = {
  code?: string;
  routes?: RawRoute[];
};

// ─── Fetch ──────────────────────────────────────────────────────────────────

/**
 * Fetch an OSRM driving route WITH step-level maneuver data.
 *
 * Returns the full route geometry plus every individual turn step, or `null`
 * on network / routing failure.
 *
 * Cache note: step data is route-specific (same from/to → same steps) so
 * we allow a 30 s CDN revalidation — shorter than the geometry-only fetch
 * (60 s) because step details change when the driver diverges from the route.
 */
export async function fetchOsrmDrivingRouteWithSteps(
  from: LatLng,
  to: LatLng,
  opts: { signal?: AbortSignal } = {},
): Promise<OsrmStepsResult | null> {
  const base =
    process.env.OSRM_BASE_URL?.replace(/\/$/, "") ||
    "https://router.project-osrm.org";

  const coords = `${from.lng.toFixed(6)},${from.lat.toFixed(6)};${to.lng.toFixed(6)},${to.lat.toFixed(6)}`;
  const url = `${base}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=true&alternatives=false`;

  try {
    const res = await fetch(url, {
      signal: opts.signal,
      next: { revalidate: 30 },
    });
    if (!res.ok) return null;

    const json = (await res.json()) as RawOsrmResponse;
    if (json.code !== "Ok" || !json.routes?.length) return null;

    const route = json.routes[0]!;

    const polyline: LatLng[] = route.geometry.coordinates.map(([lng, lat]) => ({
      lat,
      lng,
    }));

    // Flatten steps from all legs (single-destination routes have one leg).
    const steps: OsrmStep[] = (route.legs ?? []).flatMap((leg) =>
      (leg.steps ?? []).map((s) => ({
        distanceMeters: s.distance,
        durationSec: s.duration,
        name: s.name ?? "",
        maneuver: {
          type: s.maneuver.type,
          modifier: s.maneuver.modifier,
          location: { lat: s.maneuver.location[1], lng: s.maneuver.location[0] },
          bearingBefore: s.maneuver.bearing_before,
          bearingAfter: s.maneuver.bearing_after,
        },
        intersections: (s.intersections ?? []).map((i) => ({
          location: { lat: i.location[1], lng: i.location[0] },
          bearings: i.bearings,
          entry: i.entry,
        })),
      })),
    );

    return {
      polyline,
      distanceMeters: route.distance,
      durationSec: route.duration,
      steps,
    };
  } catch {
    return null;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Return `true` for maneuver types that are not meaningful bet targets:
 * "depart" (start of route), "arrive" (destination), and empty string.
 */
export function isBookendManeuver(type: string): boolean {
  return type === "depart" || type === "arrive" || type === "";
}
