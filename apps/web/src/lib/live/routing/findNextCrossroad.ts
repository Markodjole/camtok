import { bearingDegrees, metersBetween, type LatLng } from "./geometry";

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

type OverpassWayElement = {
  type: "way";
  id: number;
  nodes?: number[];
  geometry?: Array<{ lat: number; lon: number }>;
};

type OverpassElement = OverpassWayElement | { type: "node"; id: number; lat?: number; lon?: number };

type CacheEntry = {
  expiresAtMs: number;
  crossroads: NextCrossroad[];
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

async function fetchNearbyCrossroads(
  lat: number,
  lng: number,
  radiusMeters: number,
): Promise<NextCrossroad[]> {
  const key = bucketKey(lat, lng);
  const hit = CACHE.get(key);
  if (hit && hit.expiresAtMs > Date.now()) return hit.crossroads;

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
      CACHE.set(key, { expiresAtMs: Date.now() + 5_000, crossroads: [] });
      return [];
    }
    const json = (await res.json().catch(() => null)) as
      | { elements?: OverpassElement[] }
      | null;
    elements = json?.elements ?? [];
  } catch {
    return [];
  }

  // Build a node → usage-count map and remember each node's first seen coords.
  // A node used by ≥ 2 drivable ways is, by definition, an intersection.
  const countByNode = new Map<number, number>();
  const geomByNode = new Map<number, { lat: number; lng: number }>();
  for (const el of elements) {
    if (el.type !== "way") continue;
    const nodes = el.nodes;
    const geom = el.geometry;
    if (!nodes || !geom) continue;
    const len = Math.min(nodes.length, geom.length);
    for (let i = 0; i < len; i += 1) {
      const nid = nodes[i]!;
      countByNode.set(nid, (countByNode.get(nid) ?? 0) + 1);
      if (!geomByNode.has(nid)) {
        geomByNode.set(nid, { lat: geom[i]!.lat, lng: geom[i]!.lon });
      }
    }
  }

  const origin = { lat, lng };
  const crossroads: NextCrossroad[] = [];
  for (const [nodeId, count] of countByNode) {
    if (count < 2) continue;
    const geo = geomByNode.get(nodeId);
    if (!geo) continue;
    crossroads.push({
      nodeId,
      lat: geo.lat,
      lng: geo.lng,
      distanceMeters: metersBetween(origin, geo),
    });
  }

  CACHE.set(key, { expiresAtMs: Date.now() + CACHE_TTL_MS, crossroads });

  // Opportunistic sweep.
  if (CACHE.size > 256) {
    const now = Date.now();
    for (const [k, v] of CACHE.entries()) {
      if (v.expiresAtMs < now) CACHE.delete(k);
    }
  }

  return crossroads;
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
