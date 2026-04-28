import { NextRequest, NextResponse } from "next/server";
import { getLiveRoomDetail } from "@/actions/live-feed";
import { fetchOsrmDrivingRoute } from "@/lib/live/routing/osrm";
import { fetchNearbyCrossroads } from "@/lib/live/routing/findNextCrossroad";
import {
  bearingDegrees,
  cumulativeMetersAt,
  metersBetween,
  projectOntoPolyline,
  projectPoint,
  slicePolylineByDistance,
  type LatLng,
} from "@/lib/live/routing/geometry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Driver guidance: keep three blue pins ahead of the vehicle at all times.
 *
 * Strategy:
 *   1. Derive a stable motion bearing from recent GPS points.
 *   2. Ask OSRM for a long road-snapped route from the current vehicle
 *      position to a point ~1.5 km ahead in the heading direction. The
 *      returned polyline is the actual road the driver is on (and the
 *      first sensible continuation OSRM picks at each fork).
 *   3. Pull every drivable OSM crossroad in a generous bounding radius
 *      and project each onto the OSRM polyline. Anything farther than a
 *      lane width from the polyline is discarded — that's not on the
 *      driver's road. What remains is the ordered set of intersections
 *      the driver will physically pass.
 *   4. Keep a per-room queue of three active pins:
 *        - First pin must be 200–400 m of *road distance* from the
 *          vehicle when it is first selected.
 *        - Each subsequent pin must be 200–400 m of road distance past
 *          the previous pin.
 *      Once a pin is selected it sticks to the queue (visible to
 *      everyone) until the vehicle physically passes it on the road —
 *      *not* just because it dropped under the 200 m floor.
 *   5. Whenever a pin is dropped (passed), top up the queue from the far
 *      end so the driver always has three decision points lined up.
 *   6. The blue line is the last 50 m of road approaching pin #1 only —
 *      we don't render the long route anymore.
 *
 * The endpoint is intentionally stateless-looking from the client: each
 * poll returns the current queue. Persistence lives in `ROOM_STATE`
 * (in-process Map). That's fine for a single Node deployment; if we
 * ever scale horizontally this needs a shared store.
 */

type Pin = {
  /** Stable id (OSM node id) — used by clients for dedup. */
  id: number;
  lat: number;
  lng: number;
  /** Road-distance from the current vehicle position, meters. */
  distanceMeters: number;
};

type Instruction = {
  decisionId: string;
  pins: Pin[];
  /** Last 50 m of the OSRM polyline ending at pins[0]. */
  approachLine: LatLng[];
  confidence: "high" | "low";
};

type RoomState = {
  /** Ordered list of pin OSM node ids currently shown to clients. */
  pinIds: number[];
  lastUpdatedMs: number;
};

const ROOM_STATE = new Map<string, RoomState>();
const ROOM_STATE_TTL_MS = 5 * 60_000;

const TARGET_PIN_COUNT = 3;
const MIN_SPACING_M = 200;
const MAX_SPACING_M = 400;
const APPROACH_LINE_M = 50;
/** Pin is treated as "passed" once its road distance from vehicle is below this. */
const PASSED_THRESHOLD_M = 5;
/** Max perpendicular distance from polyline to consider a crossroad "on the road". */
const ON_ROUTE_THRESHOLD_M = 14;
/** Look this far ahead for the OSRM forward route. */
const FORWARD_PROBE_M = 1500;
/** Search this far for OSM crossroad candidates. */
const CROSSROAD_SEARCH_RADIUS_M = 1500;

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

type RoutePinCandidate = {
  id: number;
  lat: number;
  lng: number;
  cumulativeM: number;
};

/**
 * Project every nearby crossroad onto the OSRM polyline and keep the ones
 * sitting on the road, sorted by cumulative road distance from the start
 * (= vehicle position).
 */
function projectCrossroadsOntoRoute(
  polyline: LatLng[],
  crossroads: Array<{ nodeId: number; lat: number; lng: number }>,
): RoutePinCandidate[] {
  const out: RoutePinCandidate[] = [];
  for (const c of crossroads) {
    const proj = projectOntoPolyline(polyline, { lat: c.lat, lng: c.lng });
    if (!proj) continue;
    if (proj.distanceMeters > ON_ROUTE_THRESHOLD_M) continue;
    const cum = cumulativeMetersAt(polyline, proj.segmentIndex, proj.t);
    out.push({ id: c.nodeId, lat: c.lat, lng: c.lng, cumulativeM: cum });
  }
  out.sort((a, b) => a.cumulativeM - b.cumulativeM);
  // Deduplicate near-duplicate crossroads (same intersection mapped twice in
  // OSM). Keep the first occurrence which has the smallest cumulative.
  const seen = new Set<number>();
  const dedup: RoutePinCandidate[] = [];
  for (const p of out) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    dedup.push(p);
  }
  return dedup;
}

/**
 * From the ordered candidate list, pick a fresh queue of up to N pins where
 * each pin sits 200–400 m of road distance past the previous (or past the
 * vehicle for the first pin).
 */
function buildFreshQueue(candidates: RoutePinCandidate[]): RoutePinCandidate[] {
  const queue: RoutePinCandidate[] = [];
  let cursor = 0;
  while (queue.length < TARGET_PIN_COUNT) {
    const baseM = queue.length === 0 ? 0 : queue[queue.length - 1]!.cumulativeM;
    const next = candidates.find(
      (c) =>
        c.cumulativeM - baseM >= MIN_SPACING_M &&
        c.cumulativeM - baseM <= MAX_SPACING_M &&
        !queue.some((q) => q.id === c.id),
    );
    if (!next) break;
    queue.push(next);
    cursor += 1;
    if (cursor > 50) break;
  }
  return queue;
}

/**
 * Top-up logic: given the surviving previous pins, append new pins from the
 * candidate list keeping the 200–400 m road-distance spacing rule.
 */
function topUpQueue(
  surviving: RoutePinCandidate[],
  candidates: RoutePinCandidate[],
): RoutePinCandidate[] {
  const queue = surviving.slice();
  while (queue.length < TARGET_PIN_COUNT) {
    const baseM = queue.length === 0 ? 0 : queue[queue.length - 1]!.cumulativeM;
    const next = candidates.find(
      (c) =>
        c.cumulativeM - baseM >= MIN_SPACING_M &&
        c.cumulativeM - baseM <= MAX_SPACING_M &&
        !queue.some((q) => q.id === c.id),
    );
    if (!next) break;
    queue.push(next);
  }
  return queue;
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
    return NextResponse.json({ instruction: null, reason: "no_heading" });
  }

  const position: LatLng = { lat: last.lat, lng: last.lng };
  const farTarget = projectPoint(position, heading, FORWARD_PROBE_M);

  const [osrm, crossroads] = await Promise.all([
    fetchOsrmDrivingRoute(position, farTarget),
    fetchNearbyCrossroads(position.lat, position.lng, CROSSROAD_SEARCH_RADIUS_M),
  ]);

  if (!osrm || osrm.polyline.length < 2) {
    return NextResponse.json({ instruction: null, reason: "no_route" });
  }

  const polyline = osrm.polyline;
  const candidates = projectCrossroadsOntoRoute(polyline, crossroads);

  const nowMs = Date.now();
  const prev = ROOM_STATE.get(roomId);

  // Drop pins that are no longer ahead on the current route (vehicle passed
  // them, or driver took an unexpected branch and the pin is no longer on
  // the road).
  const survivingFromState: RoutePinCandidate[] = [];
  if (prev) {
    for (const id of prev.pinIds) {
      const c = candidates.find((x) => x.id === id);
      if (!c) continue;
      if (c.cumulativeM <= PASSED_THRESHOLD_M) continue;
      survivingFromState.push(c);
    }
  }

  // If we have nothing, start a fresh queue. Otherwise, top up.
  const queue =
    survivingFromState.length === 0
      ? buildFreshQueue(candidates)
      : topUpQueue(survivingFromState, candidates);

  ROOM_STATE.set(roomId, {
    pinIds: queue.map((p) => p.id),
    lastUpdatedMs: nowMs,
  });
  if (ROOM_STATE.size > 256) {
    for (const [k, v] of ROOM_STATE) {
      if (nowMs - v.lastUpdatedMs > ROOM_STATE_TTL_MS) ROOM_STATE.delete(k);
    }
  }

  const pins: Pin[] = queue.map((q) => ({
    id: q.id,
    lat: q.lat,
    lng: q.lng,
    distanceMeters: q.cumulativeM,
  }));

  let approachLine: LatLng[] = [];
  if (pins.length > 0) {
    const firstM = pins[0]!.distanceMeters;
    const startM = Math.max(0, firstM - APPROACH_LINE_M);
    approachLine = slicePolylineByDistance(polyline, startM, firstM);
  }

  const instruction: Instruction = {
    decisionId: pins.length > 0 ? pins.map((p) => p.id).join("-") : "empty",
    pins,
    approachLine,
    confidence: pins.length > 0 ? "high" : "low",
  };

  return NextResponse.json({ instruction });
}
