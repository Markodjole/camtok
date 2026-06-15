import {
  fetchGoogleDirectionsRoute,
  type TrafficSegment,
} from "@/lib/live/routing/googleDirections";
import { googleRoutesDisabled } from "@/lib/live/routing/googleRouteGuard";
import type { DrivingRouteStyle } from "@/lib/live/routing/drivingRouteStyle";
import { metersBetween, type LatLng } from "@/lib/live/routing/geometry";

export type DriverDestinationRoute = {
  polyline: LatLng[];
  distanceMeters: number;
  durationSec: number;
  trafficSegments: TrafficSegment[];
};

/** Perpendicular distance beyond which the map hides the stale Google path. */
export const GOOGLE_ROUTE_OFF_PATH_DISPLAY_M = 22;

/**
 * Fetch driver→destination route from Google Routes API.
 * No response caching — Maps Platform ToS prohibit storing route geometry.
 */
export async function getDriverDestinationRoute(
  driver: LatLng,
  destination: LatLng,
  opts: {
    transportMode?: string;
    drivingRouteStyle?: DrivingRouteStyle | null;
  } = {},
): Promise<DriverDestinationRoute | null> {
  if (googleRoutesDisabled()) return null;

  const fresh = await fetchGoogleDirectionsRoute(driver, destination, {
    transportMode: opts.transportMode,
    drivingRouteStyle: opts.drivingRouteStyle,
    includeTraffic: true,
  });
  if (!fresh) return null;

  return {
    polyline: fresh.polyline,
    distanceMeters: fresh.distanceMeters,
    durationSec: fresh.durationSec,
    trafficSegments: fresh.trafficSegments,
  };
}

/** @deprecated Routes are not cached — no-op kept for call-site compatibility. */
export function bustGoogleRouteCache(_roomId: string): void {}

export function distanceToDestinationMeters(
  driver: LatLng,
  destination: LatLng,
): number {
  return metersBetween(driver, destination);
}
