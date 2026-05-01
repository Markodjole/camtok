import type { LatLng } from "./geometry";
import type { DrivingRouteStyle } from "./drivingRouteStyle";
import { googleRouteTuningFromDrivingStyle } from "./drivingRouteStyle";

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

const ROUTES_TRAVEL_MODE: Record<string, string> = {
  walking: "WALK",
  walk: "WALK",
  bike: "BICYCLE",
  bicycle: "BICYCLE",
  cycle: "BICYCLE",
  scooter: "TWO_WHEELER",
  motorcycle: "TWO_WHEELER",
  car: "DRIVE",
  drive: "DRIVE",
  driving: "DRIVE",
  other_vehicle: "DRIVE",
};

/**
 * Fetch a Google Routes (v2) road polyline between two points.
 * Returns `null` on any failure so callers can render the destination pin
 * without a path until the next retry succeeds.
 *
 * Uses the modern `routes.googleapis.com/directions/v2:computeRoutes` endpoint
 * because the legacy `maps.googleapis.com/maps/api/directions/json` API is
 * disabled by default for new Google Cloud projects.
 */
export async function fetchGoogleDirectionsRoute(
  from: LatLng,
  to: LatLng,
  opts: {
    transportMode?: string;
    signal?: AbortSignal;
    /** When set, adjusts routingPreference + routeModifiers (highways/tolls/ferries). */
    drivingRouteStyle?: DrivingRouteStyle | null;
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
  if (!key) {
    console.warn("[googleDirections] missing GOOGLE_MAPS_API_KEY");
    return null;
  }

  const modeKey = (opts.transportMode ?? "drive").toLowerCase();
  const travelMode = ROUTES_TRAVEL_MODE[modeKey] ?? "DRIVE";

  const tuning = opts.drivingRouteStyle
    ? googleRouteTuningFromDrivingStyle(opts.drivingRouteStyle, opts.transportMode)
    : null;

  const motorRouting =
    travelMode === "DRIVE" || travelMode === "TWO_WHEELER";

  const routingPreference = motorRouting
    ? tuning?.routingPreference ?? "TRAFFIC_AWARE"
    : undefined;

  const routeModifiers =
    motorRouting &&
    tuning?.routeModifiers &&
    Object.keys(tuning.routeModifiers).length > 0
      ? tuning.routeModifiers
      : undefined;

  const body = {
    origin: {
      location: { latLng: { latitude: from.lat, longitude: from.lng } },
    },
    destination: {
      location: { latLng: { latitude: to.lat, longitude: to.lng } },
    },
    travelMode,
    polylineQuality: "OVERVIEW",
    polylineEncoding: "ENCODED_POLYLINE",
    ...(routingPreference ? { routingPreference } : {}),
    ...(routeModifiers ? { routeModifiers } : {}),
  };

  try {
    const res = await fetch(
      "https://routes.googleapis.com/directions/v2:computeRoutes",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask":
            "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline",
        },
        body: JSON.stringify(body),
        cache: "no-store",
        signal: opts.signal,
      },
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.warn("[googleDirections] non-OK", res.status, errText.slice(0, 240));
      return null;
    }
    const json = (await res.json()) as {
      routes?: Array<{
        distanceMeters?: number;
        duration?: string;
        polyline?: { encodedPolyline?: string };
      }>;
      error?: { code?: number; message?: string; status?: string };
    };
    if (json.error) {
      console.warn(
        "[googleDirections] error",
        json.error.status,
        json.error.message,
      );
      return null;
    }
    const route = json.routes?.[0];
    const encoded = route?.polyline?.encodedPolyline;
    if (!route || !encoded) {
      console.warn("[googleDirections] empty routes response");
      return null;
    }
    const polyline = decodeGooglePolyline(encoded);
    if (polyline.length < 2) {
      console.warn("[googleDirections] decoded polyline too short");
      return null;
    }
    const durationSec = route.duration
      ? Number((route.duration ?? "0s").replace(/s$/, "")) || 0
      : 0;
    return {
      polyline,
      distanceMeters: route.distanceMeters ?? 0,
      durationSec,
    };
  } catch (err) {
    console.warn(
      "[googleDirections] fetch failed",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
