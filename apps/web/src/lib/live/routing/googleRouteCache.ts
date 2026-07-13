import {
  fetchGoogleDirectionsRoute,
  type TrafficSegment,
} from "@/lib/live/routing/googleDirections";
import { googleRoutesDisabled } from "@/lib/live/routing/googleRouteGuard";
import type { DrivingRouteStyle } from "@/lib/live/routing/drivingRouteStyle";
import {
  fetchOsrmRoute,
  osrmProfileForTransportMode,
} from "@/lib/live/routing/osrm";
import { metersBetween, type LatLng } from "@/lib/live/routing/geometry";

export type DriverDestinationRoute = {
  polyline: LatLng[];
  distanceMeters: number;
  durationSec: number;
  trafficSegments: TrafficSegment[];
  /** Who produced the polyline — OSRM is free; Google is billable. */
  source: "google" | "osrm";
};

/** Perpendicular distance beyond which the map hides the stale Google path. */
export const GOOGLE_ROUTE_OFF_PATH_DISPLAY_M = 22;

/**
 * Fetch driver→destination road polyline.
 * Prefers Google Routes when enabled; otherwise (and on Google failure) uses
 * free OSRM so the suggested line still shows without Maps billing.
 */
export async function getDriverDestinationRoute(
  driver: LatLng,
  destination: LatLng,
  opts: {
    transportMode?: string;
    drivingRouteStyle?: DrivingRouteStyle | null;
  } = {},
): Promise<DriverDestinationRoute | null> {
  if (!googleRoutesDisabled()) {
    const fresh = await fetchGoogleDirectionsRoute(driver, destination, {
      transportMode: opts.transportMode,
      drivingRouteStyle: opts.drivingRouteStyle,
      includeTraffic: true,
    });
    if (fresh) {
      return {
        polyline: fresh.polyline,
        distanceMeters: fresh.distanceMeters,
        durationSec: fresh.durationSec,
        trafficSegments: fresh.trafficSegments,
        source: "google",
      };
    }
  }

  const osrm = await fetchOsrmRoute(driver, destination, {
    profile: osrmProfileForTransportMode(opts.transportMode),
  });
  if (!osrm || osrm.polyline.length < 2) return null;

  return {
    polyline: osrm.polyline,
    distanceMeters: osrm.distanceMeters,
    durationSec: osrm.durationSec,
    trafficSegments: [],
    source: "osrm",
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
