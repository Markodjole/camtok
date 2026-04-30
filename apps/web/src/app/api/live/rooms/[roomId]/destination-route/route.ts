import { NextRequest, NextResponse } from "next/server";
import { getLiveRoomDetail } from "@/actions/live-feed";
import { fetchGoogleDirectionsRoute } from "@/lib/live/routing/googleDirections";
import {
  metersBetween,
  projectOntoPolyline,
  type LatLng,
} from "@/lib/live/routing/geometry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Per-room cache of the last Google Directions polyline.
 *
 * We only refetch when:
 *   - the cache is stale (> CACHE_MAX_AGE_MS)
 *   - the driver has drifted more than OFF_ROUTE_THRESHOLD_M off the
 *     stored polyline (perpendicular distance), OR
 *   - the driver is now closer to the destination than the polyline's
 *     end (unlikely but possible after a shortcut).
 *
 * Single-process Map is fine for now; behind a load balancer this
 * would need a shared store (Redis/Supabase row).
 */
type Cached = {
  polyline: LatLng[];
  distanceMeters: number;
  durationSec: number;
  destinationLat: number;
  destinationLng: number;
  fetchedAtMs: number;
};

const ROUTE_CACHE = new Map<string, Cached>();
const CACHE_MAX_AGE_MS = 45_000;
const OFF_ROUTE_THRESHOLD_M = 40;
const DESTINATION_REACHED_M = 25;

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ roomId: string }> },
) {
  const { roomId } = await ctx.params;
  const res = await getLiveRoomDetail(roomId);
  const room = res.room;
  if (!room) {
    return NextResponse.json({ destination: null, route: null, reason: "no_room" });
  }
  if (!room.destination) {
    return NextResponse.json({ destination: null, route: null, reason: "no_destination" });
  }
  const points = room.routePoints;
  const last = points[points.length - 1];
  if (!last) {
    return NextResponse.json({
      destination: room.destination,
      route: null,
      reason: "no_position",
    });
  }

  const driver: LatLng = { lat: last.lat, lng: last.lng };
  const dest: LatLng = { lat: room.destination.lat, lng: room.destination.lng };

  const distanceToDest = metersBetween(driver, dest);
  if (distanceToDest <= DESTINATION_REACHED_M) {
    ROUTE_CACHE.delete(roomId);
    return NextResponse.json({
      destination: room.destination,
      route: null,
      reason: "arrived",
      distanceToDestinationMeters: distanceToDest,
    });
  }

  const cached = ROUTE_CACHE.get(roomId);
  const destinationChanged =
    cached &&
    (Math.abs(cached.destinationLat - dest.lat) > 1e-6 ||
      Math.abs(cached.destinationLng - dest.lng) > 1e-6);

  let needsRefetch =
    !cached ||
    destinationChanged ||
    Date.now() - cached.fetchedAtMs > CACHE_MAX_AGE_MS;

  if (!needsRefetch && cached) {
    const proj = projectOntoPolyline(cached.polyline, driver);
    if (!proj || proj.distanceMeters > OFF_ROUTE_THRESHOLD_M) {
      needsRefetch = true;
    }
  }

  let route = cached
    ? {
        polyline: cached.polyline,
        distanceMeters: cached.distanceMeters,
        durationSec: cached.durationSec,
      }
    : null;

  if (needsRefetch) {
    const fresh = await fetchGoogleDirectionsRoute(driver, dest, {
      transportMode: room.transportMode,
    });
    if (fresh) {
      ROUTE_CACHE.set(roomId, {
        polyline: fresh.polyline,
        distanceMeters: fresh.distanceMeters,
        durationSec: fresh.durationSec,
        destinationLat: dest.lat,
        destinationLng: dest.lng,
        fetchedAtMs: Date.now(),
      });
      route = fresh;
    }
  }

  if (ROUTE_CACHE.size > 256) {
    const now = Date.now();
    for (const [k, v] of ROUTE_CACHE) {
      if (now - v.fetchedAtMs > 5 * 60_000) ROUTE_CACHE.delete(k);
    }
  }

  return NextResponse.json({
    destination: room.destination,
    route,
    distanceToDestinationMeters: distanceToDest,
    refetched: needsRefetch,
  });
}
