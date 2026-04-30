import type { LatLng } from "./geometry";

/**
 * Decode a Google encoded polyline (precision 5) to a list of lat/lng.
 * Spec: https://developers.google.com/maps/documentation/utilities/polylinealgorithm
 */
export function decodeGooglePolyline(encoded: string): LatLng[] {
  const len = encoded.length;
  const points: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < len) {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlat = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    lat += dlat;

    result = 0;
    shift = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlng = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    lng += dlng;

    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
}

const DIRECTIONS_TRAVEL_MODE: Record<string, string> = {
  walking: "walking",
  bike: "bicycling",
  scooter: "bicycling",
  car: "driving",
  other_vehicle: "driving",
};

/**
 * Fetch a Google Directions route between two points. Falls back to
 * `null` on any failure so callers can degrade gracefully (e.g. show
 * the destination pin alone without a suggested polyline).
 */
export async function fetchGoogleDirectionsRoute(
  from: LatLng,
  to: LatLng,
  opts: {
    transportMode?: string;
    signal?: AbortSignal;
  } = {},
): Promise<{
  polyline: LatLng[];
  distanceMeters: number;
  durationSec: number;
} | null> {
  const key =
    process.env.GOOGLE_MAPS_API_KEY ??
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ??
    "";
  if (!key) return null;

  const mode = DIRECTIONS_TRAVEL_MODE[opts.transportMode ?? "driving"] ?? "driving";
  const url = new URL("https://maps.googleapis.com/maps/api/directions/json");
  url.searchParams.set("origin", `${from.lat.toFixed(6)},${from.lng.toFixed(6)}`);
  url.searchParams.set("destination", `${to.lat.toFixed(6)},${to.lng.toFixed(6)}`);
  url.searchParams.set("mode", mode);
  url.searchParams.set("key", key);
  url.searchParams.set("alternatives", "false");

  try {
    const res = await fetch(url.toString(), {
      cache: "no-store",
      signal: opts.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      status?: string;
      error_message?: string;
      routes?: Array<{
        overview_polyline?: { points?: string };
        legs?: Array<{
          distance?: { value?: number };
          duration?: { value?: number };
        }>;
      }>;
    };
    if (json.status !== "OK" || !json.routes?.length) return null;
    const route = json.routes[0]!;
    const encoded = route.overview_polyline?.points;
    if (!encoded) return null;
    const polyline = decodeGooglePolyline(encoded);
    if (polyline.length < 2) return null;
    const distanceMeters = (route.legs ?? []).reduce(
      (acc, l) => acc + (l.distance?.value ?? 0),
      0,
    );
    const durationSec = (route.legs ?? []).reduce(
      (acc, l) => acc + (l.duration?.value ?? 0),
      0,
    );
    return { polyline, distanceMeters, durationSec };
  } catch {
    return null;
  }
}
