import {
  fetchGoogleDirectionsRoute,
  type TrafficSegment,
} from "@/lib/live/routing/googleDirections";
import type { DrivingRouteStyle } from "@/lib/live/routing/drivingRouteStyle";
import {
  metersBetween,
  projectOntoPolyline,
  type LatLng,
} from "@/lib/live/routing/geometry";

export type CachedDriverDestinationRoute = {
  polyline: LatLng[];
  distanceMeters: number;
  durationSec: number;
  trafficSegments: TrafficSegment[];
};

type CacheEntry = CachedDriverDestinationRoute & {
  destinationLat: number;
  destinationLng: number;
  driverBucket: string;
  fetchedAtMs: number;
};

/** Shared in-process cache — one Google fetch per room per TTL window. */
const ROUTE_CACHE = new Map<string, CacheEntry>();

/** Keep Google calls low; route shape does not change second-to-second. */
export const GOOGLE_ROUTE_CACHE_MAX_AGE_MS = 180_000;

const OFF_ROUTE_THRESHOLD_M = 12;
const DRIVER_BUCKET_DEG = 0.0008;

function bucketForDriver(p: LatLng): string {
  const lat = Math.round(p.lat / DRIVER_BUCKET_DEG);
  const lng = Math.round(p.lng / DRIVER_BUCKET_DEG);
  return `${lat}|${lng}`;
}

export function bustGoogleRouteCache(roomId: string): void {
  ROUTE_CACHE.delete(roomId);
}

/**
 * Fetch (or reuse) the driver→destination Google route for a live room.
 * Used by destination-route polling and driver-route planning so they do
 * not each spam computeRoutes independently.
 */
export async function getDriverDestinationRoute(
  roomId: string,
  driver: LatLng,
  destination: LatLng,
  opts: {
    transportMode?: string;
    drivingRouteStyle?: DrivingRouteStyle | null;
    /** When true, refetch if the driver has drifted off the cached polyline. */
    checkOffRoute?: boolean;
  } = {},
): Promise<{ route: CachedDriverDestinationRoute; refetched: boolean } | null> {
  const cached = ROUTE_CACHE.get(roomId);
  const driverBucket = bucketForDriver(driver);
  const destinationChanged =
    cached != null &&
    (Math.abs(cached.destinationLat - destination.lat) > 1e-6 ||
      Math.abs(cached.destinationLng - destination.lng) > 1e-6);

  let needsRefetch =
    !cached ||
    destinationChanged ||
    Date.now() - cached.fetchedAtMs > GOOGLE_ROUTE_CACHE_MAX_AGE_MS ||
    cached.driverBucket !== driverBucket;

  if (!needsRefetch && cached && opts.checkOffRoute) {
    const proj = projectOntoPolyline(cached.polyline, driver);
    if (!proj || proj.distanceMeters > OFF_ROUTE_THRESHOLD_M) {
      needsRefetch = true;
    }
  }

  if (!needsRefetch && cached) {
    return {
      route: {
        polyline: cached.polyline,
        distanceMeters: cached.distanceMeters,
        durationSec: cached.durationSec,
        trafficSegments: cached.trafficSegments,
      },
      refetched: false,
    };
  }

  const fresh = await fetchGoogleDirectionsRoute(driver, destination, {
    transportMode: opts.transportMode,
    drivingRouteStyle: opts.drivingRouteStyle,
    // Essentials SKU — traffic colors are not worth 2× Routes Pro cost.
    includeTraffic: false,
  });
  if (!fresh) {
    if (!cached) return null;
    return {
      route: {
        polyline: cached.polyline,
        distanceMeters: cached.distanceMeters,
        durationSec: cached.durationSec,
        trafficSegments: cached.trafficSegments,
      },
      refetched: false,
    };
  }

  const entry: CacheEntry = {
    polyline: fresh.polyline,
    distanceMeters: fresh.distanceMeters,
    durationSec: fresh.durationSec,
    trafficSegments: fresh.trafficSegments,
    destinationLat: destination.lat,
    destinationLng: destination.lng,
    driverBucket,
    fetchedAtMs: Date.now(),
  };
  ROUTE_CACHE.set(roomId, entry);

  if (ROUTE_CACHE.size > 256) {
    const now = Date.now();
    for (const [k, v] of ROUTE_CACHE) {
      if (now - v.fetchedAtMs > 5 * 60_000) ROUTE_CACHE.delete(k);
    }
  }

  return {
    route: {
      polyline: entry.polyline,
      distanceMeters: entry.distanceMeters,
      durationSec: entry.durationSec,
      trafficSegments: entry.trafficSegments,
    },
    refetched: true,
  };
}

/** Distance from driver to destination — cheap, no Google call. */
export function distanceToDestinationMeters(driver: LatLng, destination: LatLng): number {
  return metersBetween(driver, destination);
}
