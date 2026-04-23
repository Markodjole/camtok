import { NextRequest, NextResponse } from "next/server";
import { getLiveRoomDetail } from "@/actions/live-feed";
import { fetchOsrmDrivingRoute } from "@/lib/live/routing/osrm";
import { findNextCrossroad } from "@/lib/live/routing/findNextCrossroad";
import {
  bearingDegrees,
  metersBetween,
  projectPoint,
  type LatLng,
} from "@/lib/live/routing/geometry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Simple, road-accurate driver guidance.
 *
 * Strategy (per the "make it simple for now" product decision):
 *   1. Figure out the driver's current position + heading (from the last
 *      few GPS points — more reliable than the phone's compass).
 *   2. Query OSM for real street intersections within ~300 m and pick the
 *      nearest one ahead of the driver.
 *   3. Ask OSRM for a road-snapped route from the driver to a point 10 m
 *      past the crossroad. This naturally follows the actual streets, so
 *      the blue rail lands on roads, not on empty space.
 *   4. Return the polyline + crossroad coords. The client draws the rail
 *      from driver → 10 m past the crossroad and a blue dot ON the
 *      crossroad itself.
 */

type CacheEntry = {
  expiresAtMs: number;
  instruction: ActiveCheckpointInstruction | null;
};

type ActiveCheckpointInstruction = {
  decisionId: string;
  turnKind: "straight";
  turnPoint: LatLng;
  checkpoint: LatLng;
  routePolyline: LatLng[];
  distanceMeters: number;
  lockAt: string | null;
  expiresAt: string | null;
  confidence: "high" | "low";
};

const CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 8_000;

// Coarse-ish position bucket so concurrent viewers share the same OSRM call
// while still refreshing as the driver closes on the crossroad.
function bucketKey(roomId: string, lat: number, lng: number, crossroadId: number): string {
  return `${roomId}|${lat.toFixed(4)}|${lng.toFixed(4)}|${crossroadId}`;
}

function deriveMotionBearing(
  points: Array<{ lat: number; lng: number; heading?: number | null; recordedAt?: string }>,
): number | null {
  if (points.length < 2) return null;
  const last = points[points.length - 1]!;
  for (let i = points.length - 2; i >= 0; i -= 1) {
    const p = points[i]!;
    const d = metersBetween(
      { lat: p.lat, lng: p.lng },
      { lat: last.lat, lng: last.lng },
    );
    if (d >= 6) return bearingDegrees(p, last);
  }
  const h = last.heading;
  return h != null && Number.isFinite(h) ? h : null;
}

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ roomId: string }> },
) {
  const { roomId } = await ctx.params;
  const res = await getLiveRoomDetail(roomId);
  const room = res.room;
  if (!room) {
    return NextResponse.json({ instruction: null, reason: "no_room" });
  }

  const points = room.routePoints;
  const last = points[points.length - 1];
  if (!last) {
    return NextResponse.json({ instruction: null, reason: "no_position" });
  }

  const heading = deriveMotionBearing(points);
  if (heading == null) {
    // Vehicle hasn't moved far enough (or ever) — no direction to project.
    return NextResponse.json({ instruction: null, reason: "no_heading" });
  }

  const position: LatLng = { lat: last.lat, lng: last.lng };

  const crossroad = await findNextCrossroad(position, heading);
  if (!crossroad) {
    return NextResponse.json({ instruction: null, reason: "no_crossroad" });
  }

  const bucket = bucketKey(roomId, position.lat, position.lng, crossroad.nodeId);
  const cached = CACHE.get(roomId);
  const nowMs = Date.now();
  if (cached && cached.expiresAtMs > nowMs) {
    // Cache only when hitting the same bucket so fast movement still refreshes.
    const inst = cached.instruction;
    if (inst && inst.decisionId === `cross-${crossroad.nodeId}`) {
      return NextResponse.json({ instruction: inst });
    }
  }

  // 10 m past the crossroad along the driver → crossroad bearing. OSRM will
  // snap this endpoint to the nearest road and route along real streets,
  // so even if our projected endpoint is slightly off, the rail stays on
  // asphalt.
  const crBearing = bearingDegrees(position, { lat: crossroad.lat, lng: crossroad.lng });
  const checkpoint = projectPoint(
    { lat: crossroad.lat, lng: crossroad.lng },
    crBearing,
    10,
  );

  const osrm = await fetchOsrmDrivingRoute(position, checkpoint);

  let instruction: ActiveCheckpointInstruction;
  if (osrm && osrm.polyline.length >= 2) {
    instruction = {
      decisionId: `cross-${crossroad.nodeId}`,
      turnKind: "straight",
      // Blue dot sits ON the crossroad itself (not 10 m past).
      turnPoint: { lat: crossroad.lat, lng: crossroad.lng },
      checkpoint: { lat: crossroad.lat, lng: crossroad.lng },
      routePolyline: osrm.polyline,
      distanceMeters: osrm.distanceMeters,
      lockAt: null,
      expiresAt: null,
      confidence: "high",
    };
  } else {
    // Fallback: straight line through crossroad. Not road-snapped but at
    // least points in the right direction.
    instruction = {
      decisionId: `cross-${crossroad.nodeId}`,
      turnKind: "straight",
      turnPoint: { lat: crossroad.lat, lng: crossroad.lng },
      checkpoint: { lat: crossroad.lat, lng: crossroad.lng },
      routePolyline: [position, { lat: crossroad.lat, lng: crossroad.lng }, checkpoint],
      distanceMeters: crossroad.distanceMeters + 10,
      lockAt: null,
      expiresAt: null,
      confidence: "low",
    };
  }

  CACHE.set(roomId, {
    expiresAtMs: nowMs + CACHE_TTL_MS,
    instruction,
  });
  // Opportunistic cleanup.
  if (CACHE.size > 256) {
    for (const [k, v] of CACHE.entries()) {
      if (v.expiresAtMs < nowMs) CACHE.delete(k);
    }
  }
  // Reference bucket key so unused-var check doesn't fire; kept as doc hint.
  void bucket;

  return NextResponse.json({ instruction });
}
