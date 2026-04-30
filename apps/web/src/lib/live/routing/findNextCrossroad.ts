import { bearingDegrees, metersBetween, type LatLng } from "./geometry";
import {
  normalizeOsmRoad,
  type NormalizedRoadClass,
  type OsmRoadTags,
} from "./roadClassNormalizer";

/**
 * The upcoming road intersection we want to highlight on the driver's map.
 * We pick the nearest OSM node that participates in two or more drivable
 * highway ways and that sits in the angular cone ahead of the driver.
 */
export type NextCrossroad = {
  nodeId: number;
  lat: number;
  lng: number;
  distanceMeters: number;
};

/**
 * Crossroad enriched with per-way road metadata so the bettable-intersection
 * scorer can apply the integration-spec rules (skip service/track/private
 * branches, prefer major/medium roads, require ≥2 meaningful branches).
 */
export type DetailedCrossroad = NextCrossroad & {
  /** Connected drivable ways with their normalized road class and raw tags. */
  ways: Array<{
    wayId: number;
    roadClass: NormalizedRoadClass;
    tags: OsmRoadTags;
  }>;
  /** Best class among the connected ways (used as primary comfort signal). */
  bestRoadClass: NormalizedRoadClass;
};

type OverpassWayElement = {
  type: "way";
  id: number;
  nodes?: number[];
  geometry?: Array<{ lat: number; lon: number }>;
  tags?: Record<string, string>;
};

type OverpassElement = OverpassWayElement | { type: "node"; id: number; lat?: number; lon?: number };

type CacheEntry = {
  expiresAtMs: number;
  crossroads: NextCrossroad[];
  detailed: DetailedCrossroad[];
};

// Server-side cache keyed by a ~100 m position bucket: the crossroad set in a
// small area changes slowly, so we share one Overpass call across viewers.
const CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;

function bucketKey(lat: number, lng: number): string {
  return `${lat.toFixed(3)}|${lng.toFixed(3)}`;
}

function normalizeAngle(deg: number): number {
  let a = deg % 360;
  if (a > 180) a -= 360;
  if (a < -180) a += 360;
  return a;
}

// The highway classes we treat as drivable. Excludes pedestrian / cycleway /
// steps / path so we don't snap rails to footpaths that happen to cross the
// road the driver is actually on.
const DRIVABLE_CLASSES = [
  "motorway",
  "motorway_link",
  "trunk",
  "trunk_link",
  "primary",
  "primary_link",
  "secondary",
  "secondary_link",
  "tertiary",
  "tertiary_link",
  "unclassified",
  "residential",
  "living_street",
  "service",
].join("|");

async function loadCrossroads(
  lat: number,
  lng: number,
  radiusMeters: number,
): Promise<{ crossroads: NextCrossroad[]; detailed: DetailedCrossroad[] }> {
  const key = bucketKey(lat, lng);
  const hit = CACHE.get(key);
  if (hit && hit.expiresAtMs > Date.now()) {
    return { crossroads: hit.crossroads, detailed: hit.detailed };
  }

  const query = `
[out:json][timeout:15];
way(around:${radiusMeters},${lat},${lng})["highway"~"^(${DRIVABLE_CLASSES})$"];
out body geom qt;
`.trim();

  let elements: OverpassElement[] = [];
  try {
    const res = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=UTF-8",
        Accept: "application/json",
        "User-Agent": "camtok-live-rail/1.0",
      },
      body: query,
      cache: "no-store",
    });
    if (!res.ok) {
      CACHE.set(key, {
        expiresAtMs: Date.now() + 5_000,
        crossroads: [],
        detailed: [],
      });
      return { crossroads: [], detailed: [] };
    }
    const json = (await res.json().catch(() => null)) as
      | { elements?: OverpassElement[] }
      | null;
    elements = json?.elements ?? [];
  } catch {
    return { crossroads: [], detailed: [] };
  }

  // Track per-node which drivable ways pass through it (with their tags) so
  // the consumer can score connected branches per the integration spec.
  const waysByNode = new Map<
    number,
    Array<{ wayId: number; tags: Record<string, string> }>
  >();
  const geomByNode = new Map<number, { lat: number; lng: number }>();
  for (const el of elements) {
    if (el.type !== "way") continue;
    const nodes = el.nodes;
    const geom = el.geometry;
    if (!nodes || !geom) continue;
    const tags = el.tags ?? {};
    const len = Math.min(nodes.length, geom.length);
    for (let i = 0; i < len; i += 1) {
      const nid = nodes[i]!;
      let bucket = waysByNode.get(nid);
      if (!bucket) {
        bucket = [];
        waysByNode.set(nid, bucket);
      }
      bucket.push({ wayId: el.id, tags });
      if (!geomByNode.has(nid)) {
        geomByNode.set(nid, { lat: geom[i]!.lat, lng: geom[i]!.lon });
      }
    }
  }

  const origin = { lat, lng };
  const crossroads: NextCrossroad[] = [];
  const detailed: DetailedCrossroad[] = [];
  for (const [nodeId, bucket] of waysByNode) {
    // Deduplicate ways that touch the same node multiple times (rare).
    const seen = new Set<number>();
    const uniqueWays = bucket.filter((w) => {
      if (seen.has(w.wayId)) return false;
      seen.add(w.wayId);
      return true;
    });
    if (uniqueWays.length < 2) continue;
    const geo = geomByNode.get(nodeId);
    if (!geo) continue;
    const distance = metersBetween(origin, geo);
    crossroads.push({
      nodeId,
      lat: geo.lat,
      lng: geo.lng,
      distanceMeters: distance,
    });

    const ways = uniqueWays.map((w) => {
      const tags: OsmRoadTags = {
        highway: w.tags.highway ?? null,
        surface: w.tags.surface ?? null,
        access: w.tags.access ?? null,
        motor_vehicle: w.tags.motor_vehicle ?? null,
        oneway: w.tags.oneway ?? null,
        lanes: w.tags.lanes ?? null,
        maxspeed: w.tags.maxspeed ?? null,
      };
      return {
        wayId: w.wayId,
        tags,
        roadClass: normalizeOsmRoad(tags),
      };
    });
    const bestRoadClass = pickBestRoadClass(ways.map((w) => w.roadClass));
    detailed.push({
      nodeId,
      lat: geo.lat,
      lng: geo.lng,
      distanceMeters: distance,
      ways,
      bestRoadClass,
    });
  }

  CACHE.set(key, {
    expiresAtMs: Date.now() + CACHE_TTL_MS,
    crossroads,
    detailed,
  });

  // Opportunistic sweep.
  if (CACHE.size > 256) {
    const now = Date.now();
    for (const [k, v] of CACHE.entries()) {
      if (v.expiresAtMs < now) CACHE.delete(k);
    }
  }

  return { crossroads, detailed };
}

const ROAD_CLASS_RANK: Record<NormalizedRoadClass, number> = {
  motorway: 7,
  major: 6,
  medium: 5,
  local: 4,
  minor: 3,
  service: 2,
  unknown: 2,
  bad: 1,
  forbidden: 0,
};

function pickBestRoadClass(
  classes: NormalizedRoadClass[],
): NormalizedRoadClass {
  let best: NormalizedRoadClass = "unknown";
  let bestRank = -1;
  for (const c of classes) {
    const rank = ROAD_CLASS_RANK[c] ?? 0;
    if (rank > bestRank) {
      best = c;
      bestRank = rank;
    }
  }
  return best;
}

export async function fetchNearbyCrossroads(
  lat: number,
  lng: number,
  radiusMeters: number,
): Promise<NextCrossroad[]> {
  const { crossroads } = await loadCrossroads(lat, lng, radiusMeters);
  return crossroads;
}

/**
 * Same Overpass call as `fetchNearbyCrossroads` but returns the connected
 * ways (with normalized road class & raw tags) for each intersection. Used
 * by the destination-aware bettable-intersection scorer.
 */
export async function fetchNearbyCrossroadsDetailed(
  lat: number,
  lng: number,
  radiusMeters: number,
): Promise<DetailedCrossroad[]> {
  const { detailed } = await loadCrossroads(lat, lng, radiusMeters);
  return detailed;
}

/**
 * Find the nearest crossroad in the driver's direction of travel. We filter
 * by straight-line distance and require the bearing to the crossroad to fall
 * within a ±`coneDegrees` cone around the current heading, so we do not
 * highlight intersections behind the car or on side streets beside it.
 */
export async function findNextCrossroad(
  position: LatLng,
  headingDeg: number,
  opts: {
    minAheadMeters?: number;
    maxAheadMeters?: number;
    coneDegrees?: number;
    searchRadiusMeters?: number;
  } = {},
): Promise<NextCrossroad | null> {
  const {
    minAheadMeters = 8,
    maxAheadMeters = 220,
    coneDegrees = 65,
    searchRadiusMeters = 300,
  } = opts;

  const all = await fetchNearbyCrossroads(
    position.lat,
    position.lng,
    searchRadiusMeters,
  );
  if (all.length === 0) return null;

  const ahead = all.filter((c) => {
    if (c.distanceMeters < minAheadMeters || c.distanceMeters > maxAheadMeters) {
      return false;
    }
    const b = bearingDegrees(position, { lat: c.lat, lng: c.lng });
    const d = Math.abs(normalizeAngle(b - headingDeg));
    return d <= coneDegrees;
  });

  ahead.sort((a, b) => a.distanceMeters - b.distanceMeters);
  return ahead[0] ?? null;
}
