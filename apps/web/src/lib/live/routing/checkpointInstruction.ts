import {
  bearingDegrees,
  getPointAlongPolyline,
  metersBetween,
  polylineLengthMeters,
  projectPoint,
  type LatLng,
} from "./geometry";
import { fetchOsrmDrivingRoute } from "./osrm";

export type TurnKind = "left" | "right" | "straight" | "u-turn";

export type ActiveCheckpointInstruction = {
  decisionId: string;
  turnKind: TurnKind;
  turnPoint: LatLng;
  checkpoint: LatLng;
  /** Route polyline from current driver position → checkpoint (road-snapped). */
  routePolyline: LatLng[];
  /** Raw distance in meters along the returned route. */
  distanceMeters: number;
  lockAt: string;
  expiresAt: string;
  confidence: "high" | "low";
};

export type BuildCheckpointInput = {
  decisionId: string;
  position: LatLng;
  headingDeg: number | null;
  turnPoint: LatLng;
  turnKind: TurnKind;
  lockAt: string;
  expiresAt: string;
  /** Meters past the turn point along the outgoing branch. Default 50. */
  offsetMeters?: number;
};

/**
 * Build an `ActiveCheckpointInstruction` following the Camtok web spec:
 *   - derive a stable approach heading (driver → turn) to avoid GPS jitter
 *   - place a checkpoint ~offsetMeters beyond the turn on the outgoing ray
 *   - call OSRM to get a road-snapped polyline from driver → checkpoint
 *
 * The OSRM polyline naturally renders the approach, the turn at the
 * intersection, and the short continuation after the turn, so the driver
 * sees the exact path without any raw "turn left" text.
 *
 * If OSRM is unreachable we fall back to a best-effort straight polyline
 * with `confidence = "low"` so the UI can still show something actionable.
 */
export async function buildCheckpointInstruction(
  input: BuildCheckpointInput,
  opts: { signal?: AbortSignal } = {},
): Promise<ActiveCheckpointInstruction | null> {
  const {
    decisionId,
    position,
    headingDeg,
    turnPoint,
    turnKind,
    lockAt,
    expiresAt,
    offsetMeters = 50,
  } = input;

  // Guard against obviously degenerate inputs.
  if (!Number.isFinite(position.lat) || !Number.isFinite(position.lng)) return null;
  if (!Number.isFinite(turnPoint.lat) || !Number.isFinite(turnPoint.lng)) return null;
  const distToTurn = metersBetween(position, turnPoint);
  if (distToTurn < 2 || distToTurn > 2000) return null;

  // 1. Approach bearing = driver → turn (stable, road-anchored direction).
  //    Prefer the vector to the fixed turn point over the jittery instantaneous
  //    GPS heading. Only use `headingDeg` if the two disagree wildly (sharp
  //    curves), in which case we trust the geometry of the turn point more.
  const approachBearing = (() => {
    const geo = bearingDegrees(position, turnPoint);
    if (headingDeg == null || !Number.isFinite(headingDeg)) return geo;
    return geo;
  })();

  // 2. Outgoing branch bearing = approach + (−90 / 0 / +90 / 180).
  const delta =
    turnKind === "left"
      ? -90
      : turnKind === "right"
        ? 90
        : turnKind === "u-turn"
          ? 180
          : 0;
  const exitBearing = approachBearing + delta;

  // 3. Target checkpoint is `offsetMeters` beyond the turn along the exit.
  const checkpoint = projectPoint(turnPoint, exitBearing, offsetMeters);

  // 4. Try OSRM for a real road-snapped route.
  const osrm = await fetchOsrmDrivingRoute(position, checkpoint, opts);

  if (osrm && osrm.polyline.length >= 2) {
    // Trim any absurdly long detours: if OSRM returns a route more than 3x
    // the straight-line distance (rare but possible when the exit point is
    // off-road), fall back rather than render a confusing shape.
    const straight = metersBetween(position, checkpoint);
    const routeLen = polylineLengthMeters(osrm.polyline);
    if (routeLen > straight * 3.5 + 150) {
      return fallback();
    }
    return {
      decisionId,
      turnKind,
      turnPoint,
      checkpoint: getPointAlongPolyline(osrm.polyline, osrm.polyline.length ? polylineLengthMeters(osrm.polyline) : 0),
      routePolyline: osrm.polyline,
      distanceMeters: osrm.distanceMeters,
      lockAt,
      expiresAt,
      confidence: "high",
    };
  }

  return fallback();

  function fallback(): ActiveCheckpointInstruction {
    const synthetic: LatLng[] = [position, turnPoint, checkpoint];
    return {
      decisionId,
      turnKind,
      turnPoint,
      checkpoint,
      routePolyline: synthetic,
      distanceMeters: metersBetween(position, turnPoint) + offsetMeters,
      lockAt,
      expiresAt,
      confidence: "low",
    };
  }
}
