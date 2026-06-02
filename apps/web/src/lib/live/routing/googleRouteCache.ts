import {
  fetchGoogleDirectionsRoute,
  type TrafficSegment,
} from "@/lib/live/routing/googleDirections";
import { googleRoutesDisabled } from "@/lib/live/routing/googleRouteGuard";
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
  fetchedAtMs: number;
};

/** Shared in-process cache — one Google fetch per room per TTL window. */
const ROUTE_CACHE = new Map<string, CacheEntry>();

/** Google route refresh interval — map line + ETA; not tied to 2.5s polls. */
export const GOOGLE_ROUTE_CACHE_MAX_AGE_MS = 180_000;

const OFF_ROUTE_THRESHOLD_M = 12;

export function bustGoogleRouteCache(roomId: string): void {
  ROUTE_CACHE.delete(roomId);
}

/** Read cached Google route without fetching (safe for fast-lane polls). */
export function peekCachedDriverDestinationRoute(
  roomId: string,
  destination?: LatLng | null,
): CachedDriverDestinationRoute | null {
  const cached = ROUTE_CACHE.get(roomId);
  if (!cached) return null;
  if (destination) {
    if (
      Math.abs(cached.destinationLat - destination.lat) > 1e-6 ||
      Math.abs(cached.destinationLng - destination.lng) > 1e-6
    ) {
      return null;
    }
  }
  if (Date.now() - cached.fetchedAtMs > GOOGLE_ROUTE_CACHE_MAX_AGE_MS) {
    return null;
  }
  return {
    polyline: cached.polyline,
    distanceMeters: cached.distanceMeters,
    durationSec: cached.durationSec,
    trafficSegments: cached.trafficSegments,
  };
}

/**
 * Fetch (or reuse) the driver→destination Google route for a live room.
 *
 * **Slow lane only** — call from destination-route polling or the server tick
 * refresher. Never from active-round / computeDriverRouteInstruction.
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
  if (googleRoutesDisabled()) {
    const peek = peekCachedDriverDestinationRoute(roomId, destination);
    return peek ? { route: peek, refetched: false } : null;
  }

  const cached = ROUTE_CACHE.get(roomId);
  const destinationChanged =
    cached != null &&
    (Math.abs(cached.destinationLat - destination.lat) > 1e-6 ||
      Math.abs(cached.destinationLng - destination.lng) > 1e-6);

  let needsRefetch =
    !cached ||
    destinationChanged ||
    Date.now() - cached.fetchedAtMs > GOOGLE_ROUTE_CACHE_MAX_AGE_MS;

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
