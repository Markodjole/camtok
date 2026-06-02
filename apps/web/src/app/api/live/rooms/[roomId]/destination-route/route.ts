import { NextRequest, NextResponse } from "next/server";
import { getLiveRoomDetail } from "@/actions/live-feed";
import {
  distanceToDestinationMeters,
  getDriverDestinationRoute,
} from "@/lib/live/routing/googleRouteCache";
import type { LatLng } from "@/lib/live/routing/geometry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  const distanceToDest = distanceToDestinationMeters(driver, dest);
  if (distanceToDest <= DESTINATION_REACHED_M) {
    return NextResponse.json({
      destination: room.destination,
      route: null,
      reason: "arrived",
      distanceToDestinationMeters: distanceToDest,
    });
  }

  const out = await getDriverDestinationRoute(roomId, driver, dest, {
    transportMode: room.transportMode,
    drivingRouteStyle: room.drivingRouteStyle,
    // Viewers read cache only — tick refreshes Google in the slow lane.
    checkOffRoute: false,
  });

  const route = out?.route ?? null;

  return NextResponse.json({
    destination: room.destination,
    route,
    distanceToDestinationMeters: distanceToDest,
    refetched: out?.refetched ?? false,
    lastFetchOk: route != null,
    reason: route ? "ok" : "google_error",
  });
}
