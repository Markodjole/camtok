import { getLiveRoomDetail } from "@/actions/live-feed";
import { fetchOsrmDrivingRoute } from "@/lib/live/routing/osrm";
import {
  fetchNearbyCrossroadsDetailed,
  type DetailedCrossroad,
} from "@/lib/live/routing/findNextCrossroad";
import { fetchGoogleDirectionsRoute } from "@/lib/live/routing/googleDirections";
import {
  isHardRejected,
  isMajorOrBetter,
  scoreRoadComfort,
  type NormalizedRoadClass,
} from "@/lib/live/routing/roadClassNormalizer";
import {
  minBranchComfortForDrivingStyle,
  type DrivingRouteStyle,
} from "@/lib/live/routing/drivingRouteStyle";
import {
  bearingDegrees,
  cumulativeMetersAt,
  metersBetween,
  polylineLengthMeters,
  projectOntoPolyline,
  projectPoint,
  slicePolylineByDistance,
  type LatLng,
} from "@/lib/live/routing/geometry";

/**
 * Driver guidance: keep three blue pins ahead of the vehicle at all times.
 * Extracted from the HTTP route so server actions and betting adapters can share
 * the same ROOM_STATE / planning caches.
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
 *   4. Keep a per-room queue of three active pins (200–400 m road spacing).
 *   5. When a pin is passed, top up the queue from the far end.
 *   6. Approach line spans ~50 m before the pin + ~20 m after.
 *
 * Persistence lives in `ROOM_STATE` (in-process Map).
 */

type Pin = {
  /** Stable id (OSM node id) — used by clients for dedup. */
  id: number;
  lat: number;
  lng: number;
  /** Road-distance from the current vehicle position, meters. */
  distanceMeters: number;
};

export type DriverRoutePin = Pin;

type Instruction = {
  decisionId: string;
  pins: Pin[];
  /** Guidance segment around pins[0]: ~50 m before + ~20 m after. */
  approachLine: LatLng[];
  confidence: "high" | "low";
};

export type DriverRouteInstruction = Instruction;

type PinAnchor = { lat: number; lng: number };

type RoomState = {
  /** Ordered list of pin OSM node ids currently shown to clients. */
  pinIds: number[];
  /**
   * World coordinates fixed the first time each id enters the queue.
   * When Overpass / Google polyline jitters, the same node can briefly
   * disappear from `candidates` or jump in cumulativeM — we keep the
   * visual pin here until the vehicle actually passes it.
   */
  anchors: Record<number, PinAnchor>;
  lastUpdatedMs: number;
};

const ROOM_STATE = new Map<string, RoomState>();
const ROOM_STATE_TTL_MS = 5 * 60_000;

const TARGET_PIN_COUNT = 3;
const APPROACH_LINE_BEFORE_M = 50;
const APPROACH_LINE_AFTER_M = 20;
/** Pin is treated as "passed" once its road distance from vehicle is below this. */
const PASSED_THRESHOLD_M = 5;
/** On-map straight-line pass radius when re-projecting a sticky anchor (meters). */
const PASSED_ANCHOR_LINE_M = 12;
/** Drop a sticky pin if it projects farther than this from the active polyline (meters). */
const STICKY_OFF_ROUTE_DROP_M = 45;
/** Max perpendicular distance from polyline to consider a crossroad "on the road". */
const ON_ROUTE_THRESHOLD_M = 14;
/** Look this far ahead for the OSRM forward route. */
const FORWARD_PROBE_M = 1500;
/** Search this far for OSM crossroad candidates. */
const CROSSROAD_SEARCH_RADIUS_M = 1500;
/**
 * Once we have a Google destination route, only consider candidates within
 * the first PLANNING_LOOKAHEAD_M meters of that polyline so pins always sit
 * on the immediate maneuver horizon.
 */
const PLANNING_LOOKAHEAD_M = 1500;
/** Min comfort score to consider a candidate's best connected branch usable. */
const MIN_BRANCH_COMFORT_SCORE = 0.45;

type PlanningRoute = {
  polyline: LatLng[];
  source: "google" | "osrm";
};

/**
 * Per-room cache for the driver→destination Google polyline used to plan
 * blue-pin placement. Keeps the shared driver-route handler from spamming
 * the Google Routes endpoint on every viewer poll while still recomputing
 * when the driver drifts off the planned road.
 */
type PlanningCacheEntry = {
  polyline: LatLng[];
  destLat: number;
  destLng: number;
  driverBucket: string;
  fetchedAtMs: number;
};
const PLANNING_ROUTE_CACHE = new Map<string, PlanningCacheEntry>();
const PLANNING_ROUTE_TTL_MS = 30_000;
const PLANNING_DRIVER_BUCKET_DEG = 0.0008; // ~85 m

/**
 * Force-expire the planning route cache for a room so the next call to
 * `computeDriverRouteInstruction` (or a zone-exit estimate) fetches a
 * completely fresh polyline from Google.  Call this immediately before
 * triggering a zone_exit_time market.
 */
export function bustPlanningRouteCache(roomId: string): void {
  PLANNING_ROUTE_CACHE.delete(roomId);
}

function planningBucket(p: LatLng): string {
  const lat = Math.round(p.lat / PLANNING_DRIVER_BUCKET_DEG);
  const lng = Math.round(p.lng / PLANNING_DRIVER_BUCKET_DEG);
  return `${lat}|${lng}`;
}

function spacingWindowForSpeed(speedMps: number | null | undefined): {
  minSpacingM: number;
  maxSpacingM: number;
} {
  const s = speedMps ?? 0;
  if (s <= 2) return { minSpacingM: 150, maxSpacingM: 180 };
  if (s <= 6) return { minSpacingM: 170, maxSpacingM: 210 };
  if (s <= 12) return { minSpacingM: 190, maxSpacingM: 230 };
  return { minSpacingM: 210, maxSpacingM: 250 };
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

type RoutePinCandidate = {
  id: number;
  lat: number;
  lng: number;
  cumulativeM: number;
  /** Best comfort score among connected ways. */
  comfort: number;
  /** Best (highest) connected road class. */
  bestRoadClass: NormalizedRoadClass;
  /** How many connected ways pass at least the comfort floor. */
  meaningfulBranches: number;
  /** Set when the candidate sits on the destination-aware planning polyline. */
  onPlannedRoute: boolean;
};

/**
 * Project every nearby crossroad onto the planning polyline and apply the
 * "bettable crossroad" rules from
 * `camtok_road_api_bettable_crossroads_cursor_instructions.md`:
 *
 *   - hard-reject candidates whose only connected ways are tracks /
 *     footways / private / forbidden
 *   - require ≥ 2 meaningful branches (comfort ≥ MIN_BRANCH_COMFORT_SCORE)
 *   - keep unknown roads as a soft fallback so we don't go silent in OSM
 *     under-mapped areas
 *
 * Returned candidates are sorted by cumulative road distance from the start
 * of the polyline (= vehicle position).
 */
function projectCrossroadsOntoRoute(
  polyline: LatLng[],
  crossroads: DetailedCrossroad[],
  opts: { onPlannedRoute: boolean; minBranchComfort: number },
): RoutePinCandidate[] {
  const out: RoutePinCandidate[] = [];
  for (const c of crossroads) {
    const proj = projectOntoPolyline(polyline, { lat: c.lat, lng: c.lng });
    if (!proj) continue;
    if (proj.distanceMeters > ON_ROUTE_THRESHOLD_M) continue;
    const cum = cumulativeMetersAt(polyline, proj.segmentIndex, proj.t);

    // Apply bettable-branch filtering — require at least one connected way
    // that is realistically drivable (not service-only / tracks / private).
    const usableWays = c.ways.filter((w) => !isHardRejected(w.roadClass, w.tags));
    if (usableWays.length === 0) continue;

    let bestComfort = 0;
    let meaningful = 0;
    for (const w of usableWays) {
      const cf = scoreRoadComfort(w.roadClass, w.tags.surface, w.tags.access);
      if (cf > bestComfort) bestComfort = cf;
      if (cf >= opts.minBranchComfort) meaningful += 1;
    }

    // Need at least two non-hard-rejected branches for a real intersection;
    // unknown-class branches still count so we don't black out under-mapped
    // areas where Overpass returns sparse tags.
    if (usableWays.length < 2) continue;

    out.push({
      id: c.nodeId,
      lat: c.lat,
      lng: c.lng,
      cumulativeM: cum,
      comfort: bestComfort,
      bestRoadClass: c.bestRoadClass,
      meaningfulBranches: meaningful,
      onPlannedRoute: opts.onPlannedRoute,
    });
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

function ensureAnchors(
  queue: RoutePinCandidate[],
  anchors: Record<number, PinAnchor>,
): Record<number, PinAnchor> {
  const next = { ...anchors };
  for (const q of queue) {
    if (!next[q.id]) {
      next[q.id] = { lat: q.lat, lng: q.lng };
    }
  }
  // Drop anchors for ids no longer in queue
  const ids = new Set(queue.map((q) => q.id));
  for (const k of Object.keys(next)) {
    if (!ids.has(Number(k))) delete next[Number(k)];
  }
  return next;
}

/**
 * Rebuild ordered queue from previous pin ids, keeping positions stable until
 * the vehicle passes each pin (road-ahead distance or straight-line fallback).
 */
/**
 * Returns true when `anchor` is in the rearward hemisphere of the vehicle.
 * We use a dot-product between the forward heading vector and the
 * vehicle→anchor vector; negative means behind.
 */
function isAnchorBehindVehicle(
  vehicle: LatLng,
  anchor: PinAnchor,
  headingDeg: number,
): boolean {
  const rad = (headingDeg * Math.PI) / 180;
  const fwdX = Math.sin(rad); // east component
  const fwdY = Math.cos(rad); // north component
  const dx = anchor.lng - vehicle.lng;
  const dy = anchor.lat - vehicle.lat;
  return fwdX * dx + fwdY * dy < 0;
}

function resolveCommittedQueue(params: {
  polyline: LatLng[];
  vehicle: LatLng;
  heading: number | null;
  prevPinIds: number[];
  anchors: Record<number, PinAnchor>;
  candidates: RoutePinCandidate[];
  spacing: { minSpacingM: number; maxSpacingM: number };
}): { queue: RoutePinCandidate[]; anchors: Record<number, PinAnchor> } {
  const { polyline, vehicle, heading, prevPinIds, anchors, candidates, spacing } = params;
  const candById = new Map(candidates.map((c) => [c.id, c] as const));
  const vProj = projectOntoPolyline(polyline, vehicle);
  const vehCum = vProj
    ? cumulativeMetersAt(polyline, vProj.segmentIndex, vProj.t)
    : 0;

  const surviving: RoutePinCandidate[] = [];
  for (const id of prevPinIds) {
    const fromCand = candById.get(id);
    const anchor: PinAnchor | null =
      anchors[id] ??
      (fromCand ? { lat: fromCand.lat, lng: fromCand.lng } : null);
    if (!anchor) continue;

    // Drop any pin that is physically behind the vehicle — this catches the
    // case where the driver turned away from the pin's road and the anchor
    // is now in the rearward half of the driver's view.
    if (heading != null && isAnchorBehindVehicle(vehicle, anchor, heading)) {
      continue;
    }

    let pinCum: number;
    let meta: Pick<
      RoutePinCandidate,
      "comfort" | "bestRoadClass" | "meaningfulBranches" | "onPlannedRoute"
    >;
    if (fromCand) {
      pinCum = fromCand.cumulativeM;
      meta = {
        comfort: fromCand.comfort,
        bestRoadClass: fromCand.bestRoadClass,
        meaningfulBranches: fromCand.meaningfulBranches,
        onPlannedRoute: fromCand.onPlannedRoute,
      };
    } else {
      const pProj = projectOntoPolyline(polyline, anchor);
      if (!pProj || pProj.distanceMeters > STICKY_OFF_ROUTE_DROP_M) {
        continue;
      }
      pinCum = cumulativeMetersAt(polyline, pProj.segmentIndex, pProj.t);
      meta = {
        comfort: 0.5,
        bestRoadClass: "unknown",
        meaningfulBranches: 2,
        onPlannedRoute: true,
      };
    }

    const ahead = pinCum - vehCum;
    if (ahead <= PASSED_THRESHOLD_M) continue;
    if (metersBetween(vehicle, anchor) < PASSED_ANCHOR_LINE_M) continue;

    surviving.push({
      id,
      lat: anchor.lat,
      lng: anchor.lng,
      cumulativeM: pinCum,
      ...meta,
    });
  }

  const queue =
    surviving.length === 0
      ? buildFreshQueue(candidates, vehCum, spacing)
      : topUpQueue(surviving, candidates, vehCum, spacing);

  const nextAnchors = ensureAnchors(queue, anchors);
  return { queue, anchors: nextAnchors };
}

/**
 * From the ordered candidate list, pick a fresh queue of up to N pins where
 * each pin sits minSpacingM–maxSpacingM of road distance past the previous,
 * or past the VEHICLE's current polyline position for the first pin.
 * Using vehCum (not 0) ensures no pin behind the vehicle is ever selected.
 */
function buildFreshQueue(
  candidates: RoutePinCandidate[],
  vehCum: number,
  spacing: { minSpacingM: number; maxSpacingM: number },
): RoutePinCandidate[] {
  const queue: RoutePinCandidate[] = [];
  let cursor = 0;
  while (queue.length < TARGET_PIN_COUNT) {
    const baseM = queue.length === 0 ? vehCum : queue[queue.length - 1]!.cumulativeM;
    const next = candidates.find(
      (c) =>
        c.cumulativeM - baseM >= spacing.minSpacingM &&
        c.cumulativeM - baseM <= spacing.maxSpacingM &&
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
 * candidate list keeping the spacing rule. vehCum is the fallback base so
 * top-up on an empty surviving list also starts from the vehicle.
 */
function topUpQueue(
  surviving: RoutePinCandidate[],
  candidates: RoutePinCandidate[],
  vehCum: number,
  spacing: { minSpacingM: number; maxSpacingM: number },
): RoutePinCandidate[] {
  const queue = surviving.slice();
  while (queue.length < TARGET_PIN_COUNT) {
    const baseM = queue.length === 0 ? vehCum : queue[queue.length - 1]!.cumulativeM;
    const next = candidates.find(
      (c) =>
        c.cumulativeM - baseM >= spacing.minSpacingM &&
        c.cumulativeM - baseM <= spacing.maxSpacingM &&
        !queue.some((q) => q.id === c.id),
    );
    if (!next) break;
    queue.push(next);
  }
  return queue;
}

/**
 * Resolve a planning polyline to use for blue-pin selection.
 *
 *  1. If the room has a destination, ask Google Routes for a road-snapped
 *     polyline driver→destination, then trim it to the next
 *     PLANNING_LOOKAHEAD_M meters. We cache per-room and re-fetch when the
 *     driver drifts off-route or the destination changes.
 *  2. Otherwise (no destination, or Google returned nothing), fall back to
 *     the existing OSRM forward probe in the heading direction.
 */
async function resolvePlanningPolyline(params: {
  roomId: string;
  driver: LatLng;
  heading: number;
  destination: { lat: number; lng: number } | null;
  transportMode?: string;
  drivingRouteStyle: DrivingRouteStyle;
}): Promise<PlanningRoute | null> {
  const { roomId, driver, heading, destination, transportMode, drivingRouteStyle } =
    params;

  if (destination) {
    const cached = PLANNING_ROUTE_CACHE.get(roomId);
    const driverBucket = planningBucket(driver);
    const cacheValid =
      cached &&
      Math.abs(cached.destLat - destination.lat) < 1e-6 &&
      Math.abs(cached.destLng - destination.lng) < 1e-6 &&
      cached.driverBucket === driverBucket &&
      Date.now() - cached.fetchedAtMs < PLANNING_ROUTE_TTL_MS;

    let polyline = cacheValid ? cached!.polyline : null;
    if (!polyline) {
      const google = await fetchGoogleDirectionsRoute(driver, destination, {
        transportMode,
        drivingRouteStyle,
      });
      if (google && google.polyline.length >= 2) {
        polyline = google.polyline;
        PLANNING_ROUTE_CACHE.set(roomId, {
          polyline,
          destLat: destination.lat,
          destLng: destination.lng,
          driverBucket,
          fetchedAtMs: Date.now(),
        });
      }
    }
    if (polyline && polyline.length >= 2) {
      const total = polylineLengthMeters(polyline);
      const trimmed =
        total > PLANNING_LOOKAHEAD_M
          ? slicePolylineByDistance(polyline, 0, PLANNING_LOOKAHEAD_M)
          : polyline;
      if (trimmed.length >= 2) {
        return { polyline: trimmed, source: "google" };
      }
    }
  }

  const farTarget = projectPoint(driver, heading, FORWARD_PROBE_M);
  const osrm = await fetchOsrmDrivingRoute(driver, farTarget);
  if (!osrm || osrm.polyline.length < 2) return null;
  return { polyline: osrm.polyline, source: "osrm" };
}

export type DriverRoutePlanningMeta = {
  source: "google" | "osrm";
  destinationAware: boolean;
  bestRoadClasses: NormalizedRoadClass[];
  meaningfulBranchesPerPin: number[];
  onlyMajorRoads: boolean;
};

export async function computeDriverRouteInstruction(
  roomId: string,
): Promise<
  | { instruction: null; reason: string }
  | { instruction: Instruction; planning: DriverRoutePlanningMeta }
> {
  const res = await getLiveRoomDetail(roomId);
  const room = res.room;
  if (!room) {
    return { instruction: null, reason: "no_room" };
  }

  const points = room.routePoints;
  const last = points[points.length - 1];
  if (!last) {
    return { instruction: null, reason: "no_position" };
  }

  const heading = deriveMotionBearing(points);
  if (heading == null) {
    return { instruction: null, reason: "no_heading" };
  }

  const position: LatLng = { lat: last.lat, lng: last.lng };
  const spacing = spacingWindowForSpeed(last.speedMps);

  const destination = room.destination
    ? { lat: room.destination.lat, lng: room.destination.lng }
    : null;

  const drivingRouteStyle = room.drivingRouteStyle;
  const minBranchComfort =
    minBranchComfortForDrivingStyle(drivingRouteStyle);

  const [planning, crossroads] = await Promise.all([
    resolvePlanningPolyline({
      roomId,
      driver: position,
      heading,
      destination,
      transportMode: room.transportMode,
      drivingRouteStyle,
    }),
    fetchNearbyCrossroadsDetailed(
      position.lat,
      position.lng,
      CROSSROAD_SEARCH_RADIUS_M,
    ),
  ]);

  if (!planning || planning.polyline.length < 2) {
    return { instruction: null, reason: "no_route" };
  }

  const polyline = planning.polyline;
  const candidates = projectCrossroadsOntoRoute(polyline, crossroads, {
    onPlannedRoute: planning.source === "google",
    minBranchComfort,
  });

  const nowMs = Date.now();
  const prev = ROOM_STATE.get(roomId);

  const { queue, anchors } = resolveCommittedQueue({
    polyline,
    vehicle: position,
    heading,
    prevPinIds: prev?.pinIds ?? [],
    anchors: prev?.anchors ?? {},
    candidates,
    spacing,
  });

  ROOM_STATE.set(roomId, {
    pinIds: queue.map((p) => p.id),
    anchors,
    lastUpdatedMs: nowMs,
  });
  if (ROOM_STATE.size > 256) {
    for (const [k, v] of ROOM_STATE) {
      if (nowMs - v.lastUpdatedMs > ROOM_STATE_TTL_MS) ROOM_STATE.delete(k);
    }
  }

  const vProjHead = projectOntoPolyline(polyline, position);
  const vehCumHead = vProjHead
    ? cumulativeMetersAt(polyline, vProjHead.segmentIndex, vProjHead.t)
    : 0;

  const pins: Pin[] = queue.map((q) => ({
    id: q.id,
    lat: q.lat,
    lng: q.lng,
    distanceMeters: Math.max(0, q.cumulativeM - vehCumHead),
  }));

  let approachLine: LatLng[] = [];
  if (queue.length > 0) {
    const firstPinCum = queue[0]!.cumulativeM;
    const startM = Math.max(0, firstPinCum - APPROACH_LINE_BEFORE_M);
    const endM = Math.max(startM, firstPinCum + APPROACH_LINE_AFTER_M);
    approachLine = slicePolylineByDistance(polyline, startM, endM);
  }

  const instruction: Instruction = {
    decisionId: pins.length > 0 ? pins.map((p) => p.id).join("-") : "empty",
    pins,
    approachLine,
    confidence: pins.length > 0 ? "high" : "low",
  };

  return {
    instruction,
    planning: {
      source: planning.source,
      destinationAware:
        planning.source === "google" && Boolean(destination),
      bestRoadClasses: queue.map((q) => q.bestRoadClass),
      meaningfulBranchesPerPin: queue.map((q) => q.meaningfulBranches),
      onlyMajorRoads: queue.every((q) => isMajorOrBetter(q.bestRoadClass)),
    },
  };
}
