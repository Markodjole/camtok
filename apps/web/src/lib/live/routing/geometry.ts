/**
 * Geometry helpers for driver-map routing.
 *
 * All inputs/outputs are in WGS84 decimal degrees unless documented otherwise.
 * Distances are calculated with the equirectangular approximation which is
 * accurate to within ~0.2% at the < 500 m scales used for checkpoint offsets.
 */

export type LatLng = { lat: number; lng: number };

const EARTH_M_PER_LAT_DEG = 111_320;

function cosLat(latDeg: number): number {
  return Math.cos((latDeg * Math.PI) / 180);
}

export function metersBetween(a: LatLng, b: LatLng): number {
  const latAvg = (a.lat + b.lat) / 2;
  const dy = (b.lat - a.lat) * EARTH_M_PER_LAT_DEG;
  const dx = (b.lng - a.lng) * EARTH_M_PER_LAT_DEG * cosLat(latAvg);
  return Math.hypot(dx, dy);
}

/**
 * Compass bearing from `a` → `b` in degrees (0 = north, clockwise).
 * Accurate enough for city-scale (< 1 km) deltas.
 */
export function bearingDegrees(a: LatLng, b: LatLng): number {
  const latAvg = (a.lat + b.lat) / 2;
  const dy = (b.lat - a.lat) * EARTH_M_PER_LAT_DEG;
  const dx = (b.lng - a.lng) * EARTH_M_PER_LAT_DEG * cosLat(latAvg);
  return (Math.atan2(dx, dy) * 180) / Math.PI;
}

/**
 * Project a lat/lng a number of meters along a bearing.
 */
export function projectPoint(
  from: LatLng,
  bearingDeg: number,
  meters: number,
): LatLng {
  const rad = (bearingDeg * Math.PI) / 180;
  const dLat = (meters * Math.cos(rad)) / EARTH_M_PER_LAT_DEG;
  const dLng =
    (meters * Math.sin(rad)) / (EARTH_M_PER_LAT_DEG * cosLat(from.lat));
  return { lat: from.lat + dLat, lng: from.lng + dLng };
}

/**
 * Walk along a polyline and return the point at the given distance (meters).
 * If the polyline is shorter than `meters`, returns the last point (caller
 * may treat this as low confidence).
 */
export function getPointAlongPolyline(
  polyline: LatLng[],
  meters: number,
): LatLng {
  if (polyline.length === 0) {
    throw new Error("getPointAlongPolyline: empty polyline");
  }
  if (polyline.length === 1 || meters <= 0) return polyline[0]!;

  let remaining = meters;
  for (let i = 1; i < polyline.length; i += 1) {
    const a = polyline[i - 1]!;
    const b = polyline[i]!;
    const segLen = metersBetween(a, b);
    if (segLen === 0) continue;
    if (remaining <= segLen) {
      const t = remaining / segLen;
      return {
        lat: a.lat + (b.lat - a.lat) * t,
        lng: a.lng + (b.lng - a.lng) * t,
      };
    }
    remaining -= segLen;
  }
  return polyline[polyline.length - 1]!;
}

export function polylineLengthMeters(polyline: LatLng[]): number {
  let total = 0;
  for (let i = 1; i < polyline.length; i += 1) {
    total += metersBetween(polyline[i - 1]!, polyline[i]!);
  }
  return total;
}

/**
 * Project a point onto a polyline, returning the nearest segment index, the
 * fractional position along that segment (0–1), the perpendicular distance
 * in meters, and the projected point itself.
 *
 * Used to clip the driver's rail so only the portion in front of the driver
 * is rendered — behind them we show the normal green trail.
 */
export function projectOntoPolyline(
  polyline: LatLng[],
  point: LatLng,
): {
  segmentIndex: number;
  t: number;
  projection: LatLng;
  distanceMeters: number;
} | null {
  if (polyline.length < 2) return null;
  let best:
    | {
        segmentIndex: number;
        t: number;
        projection: LatLng;
        distanceMeters: number;
      }
    | null = null;

  for (let i = 1; i < polyline.length; i += 1) {
    const a = polyline[i - 1]!;
    const b = polyline[i]!;
    const latAvg = (a.lat + b.lat) / 2;
    const cosA = cosLat(latAvg);
    const ax = a.lng * cosA * EARTH_M_PER_LAT_DEG;
    const ay = a.lat * EARTH_M_PER_LAT_DEG;
    const bx = b.lng * cosA * EARTH_M_PER_LAT_DEG;
    const by = b.lat * EARTH_M_PER_LAT_DEG;
    const px = point.lng * cosA * EARTH_M_PER_LAT_DEG;
    const py = point.lat * EARTH_M_PER_LAT_DEG;
    const dx = bx - ax;
    const dy = by - ay;
    const segLenSq = dx * dx + dy * dy;
    if (segLenSq === 0) continue;
    let t = ((px - ax) * dx + (py - ay) * dy) / segLenSq;
    t = Math.max(0, Math.min(1, t));
    const projX = ax + t * dx;
    const projY = ay + t * dy;
    const distMeters = Math.hypot(px - projX, py - projY);
    if (!best || distMeters < best.distanceMeters) {
      const projLat = projY / EARTH_M_PER_LAT_DEG;
      const projLng = projX / (EARTH_M_PER_LAT_DEG * cosA);
      best = {
        segmentIndex: i - 1,
        t,
        projection: { lat: projLat, lng: projLng },
        distanceMeters: distMeters,
      };
    }
  }
  return best;
}

/**
 * Return the portion of `polyline` ahead of `driver` — i.e. starting from
 * where the driver currently is and continuing to the checkpoint. If the
 * driver is already past the end of the polyline (within `doneMeters`),
 * returns an empty array signalling the rail should be cleared.
 */
export function trimPolylineAhead(
  polyline: LatLng[],
  driver: LatLng,
  opts: { doneMeters?: number; maxOffRouteMeters?: number } = {},
): LatLng[] {
  const { doneMeters = 6, maxOffRouteMeters = 40 } = opts;
  if (polyline.length < 2) return [];
  const proj = projectOntoPolyline(polyline, driver);
  if (!proj) return [];
  // Off-route by more than a lane width → the rendered rail would be
  // confusing; let the caller fall back to hiding it.
  if (proj.distanceMeters > maxOffRouteMeters) return polyline;
  const end = polyline[polyline.length - 1]!;
  if (metersBetween(proj.projection, end) < doneMeters) return [];
  const rest = polyline.slice(proj.segmentIndex + 1);
  return [proj.projection, ...rest];
}
