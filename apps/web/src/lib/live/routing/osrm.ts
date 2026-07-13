import type { LatLng } from "./geometry";
import { assertApiAllowed } from "@/lib/usage/apiUsage";

export type OsrmProfile = "driving" | "cycling" | "walking";

/**
 * Query OSRM for a route between two points (free — no Google Routes cost).
 *
 * Default endpoint is the public demo server; override with `OSRM_BASE_URL`
 * for production self-hosting. Callers should cache / throttle via
 * `assertApiAllowed("osrm")`.
 */
export async function fetchOsrmRoute(
  from: LatLng,
  to: LatLng,
  opts: { signal?: AbortSignal; profile?: OsrmProfile } = {},
): Promise<{ polyline: LatLng[]; distanceMeters: number; durationSec: number } | null> {
  const base =
    process.env.OSRM_BASE_URL?.replace(/\/$/, "") ||
    "https://router.project-osrm.org";
  const profile = opts.profile ?? "driving";
  const coords = `${from.lng.toFixed(6)},${from.lat.toFixed(6)};${to.lng.toFixed(6)},${to.lat.toFixed(6)}`;
  const url = `${base}/route/v1/${profile}/${coords}?overview=full&geometries=geojson&steps=false&alternatives=false`;

  const guard = assertApiAllowed("osrm");
  if (!guard.allowed) return null;

  try {
    const res = await fetch(url, {
      signal: opts.signal,
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

/** @deprecated Prefer `fetchOsrmRoute` — kept for existing call sites. */
export async function fetchOsrmDrivingRoute(
  from: LatLng,
  to: LatLng,
  opts: { signal?: AbortSignal } = {},
): Promise<{ polyline: LatLng[]; distanceMeters: number; durationSec: number } | null> {
  return fetchOsrmRoute(from, to, { ...opts, profile: "driving" });
}

export function osrmProfileForTransportMode(
  transportMode?: string | null,
): OsrmProfile {
  const m = (transportMode ?? "drive").toLowerCase();
  if (m === "walking" || m === "walk") return "walking";
  if (m === "bike" || m === "bicycle" || m === "cycle" || m === "scooter") {
    return "cycling";
  }
  return "driving";
}
