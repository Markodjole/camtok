import { NEXT_STEP_APPROACH_M, NEXT_STEP_ROUTE_DEVIATION_M } from "@/lib/live/betting/betWindowConstants";
import {
  cumulativeMetersAt,
  metersBetween,
  projectOntoPolyline,
  slicePolylineByDistance,
  type LatLng,
} from "@/lib/live/routing/geometry";

export type CompactLatLng = { lat: number; lng: number };

function roundCoord(p: LatLng): CompactLatLng {
  return { lat: Math.round(p.lat * 1e5) / 1e5, lng: Math.round(p.lng * 1e5) / 1e5 };
}

/**
 * Slice the planning polyline from the driver's projected position to the pin.
 * Falls back to a straight driver→pin segment when projection fails.
 */
export function buildRouteToPinPolyline(
  planningPolyline: LatLng[],
  driver: LatLng,
  stepTarget: LatLng,
): CompactLatLng[] {
  if (planningPolyline.length < 2) {
    return [roundCoord(driver), roundCoord(stepTarget)];
  }

  const driverProj = projectOntoPolyline(planningPolyline, driver);
  if (!driverProj) return [roundCoord(driver), roundCoord(stepTarget)];

  const targetProj = projectOntoPolyline(planningPolyline, stepTarget);
  if (!targetProj) return [roundCoord(driver), roundCoord(stepTarget)];

  const driverAlong = cumulativeMetersAt(
    planningPolyline,
    driverProj.segmentIndex,
    driverProj.t,
  );
  const targetAlong = cumulativeMetersAt(
    planningPolyline,
    targetProj.segmentIndex,
    targetProj.t,
  );
  const start = Math.max(0, driverAlong);
  const end = Math.max(start, targetAlong);
  const slice = slicePolylineByDistance(planningPolyline, start, end);
  if (slice.length < 2) return [roundCoord(driver), roundCoord(stepTarget)];
  return slice.map(roundCoord);
}

/**
 * True when the driver has left the path that leads to the pin and has not
 * yet reached the pin itself (within approach radius).
 */
export function isDriverOffRouteToPin(
  driver: LatLng,
  routeToPin: CompactLatLng[] | null | undefined,
  pin: LatLng | null | undefined,
  thresholdM = NEXT_STEP_ROUTE_DEVIATION_M,
): boolean {
  if (!routeToPin || routeToPin.length < 2) return false;

  if (pin) {
    const distToPin = metersBetween(driver, pin);
    if (distToPin <= NEXT_STEP_APPROACH_M) return false;
  }

  const proj = projectOntoPolyline(routeToPin, driver);
  if (!proj) return true;
  return proj.distanceMeters > thresholdM;
}
