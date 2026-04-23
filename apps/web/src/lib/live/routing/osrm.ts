import type { LatLng } from "./geometry";

/**
 * Query the public OSRM demo server for a driving route between two points.
 *
 * Returns the full route geometry as a list of `LatLng` coordinates or
 * `null` if OSRM could not produce a route (network error, invalid coords,
 * no road nearby, etc). Kept intentionally small — we only need `geometry`
 * so betting timing stays tight.
 *
 * NOTE: router.project-osrm.org is a free shared endpoint; we cache results
 * aggressively upstream (per `decisionId` + coarse position bucket) so we
 * don't hit it on every viewer poll.
 */
export async function fetchOsrmDrivingRoute(
  from: LatLng,
  to: LatLng,
  opts: { signal?: AbortSignal } = {},
): Promise<{ polyline: LatLng[]; distanceMeters: number; durationSec: number } | null> {
  const base =
    process.env.OSRM_BASE_URL?.replace(/\/$/, "") ||
    "https://router.project-osrm.org";
  const coords = `${from.lng.toFixed(6)},${from.lat.toFixed(6)};${to.lng.toFixed(6)},${to.lat.toFixed(6)}`;
  const url = `${base}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false&alternatives=false`;

  try {
    const res = await fetch(url, {
      signal: opts.signal,
      // Route shape does not change per user, allow CDN-level caching.
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      code?: string;
      routes?: Array<{
        distance: number;
        duration: number;
        geometry: { type: "LineString"; coordinates: Array<[number, number]> };
      }>;
    };
    if (json.code !== "Ok" || !json.routes?.length) return null;
    const route = json.routes[0]!;
    const polyline: LatLng[] = route.geometry.coordinates.map(([lng, lat]) => ({
      lat,
      lng,
    }));
    return {
      polyline,
      distanceMeters: route.distance,
      durationSec: route.duration,
    };
  } catch {
    return null;
  }
}
