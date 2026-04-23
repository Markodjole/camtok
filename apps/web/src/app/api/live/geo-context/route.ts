import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// --- Types ------------------------------------------------------------------

type GeoPoint = { lat: number; lng: number };

type OsmGeomPoint = { lat: number; lon: number };

type OsmMember = {
  type: string;
  ref: number;
  role: string;
  geometry?: OsmGeomPoint[];
};

type OverpassElement = {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
  geometry?: OsmGeomPoint[];
  members?: OsmMember[];
  tags?: Record<string, string>;
};

// --- Helpers ----------------------------------------------------------------

function parseCoord(value: string | null): number | null {
  if (!value) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function distanceMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const r = 6_371_000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return r * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Rough area in m² of a polygon via Shoelace – used to filter giant/tiny shapes. */
function polygonAreaM2(ring: GeoPoint[]): number {
  let area = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    area += a.lat * b.lng - b.lat * a.lng;
  }
  // Convert from degree² to m² roughly
  const deg2m = 111_320;
  return Math.abs(area / 2) * deg2m * deg2m;
}

/** Centroid of a polygon */
function centroid(ring: GeoPoint[]): GeoPoint {
  const n = ring.length;
  let lat = 0, lng = 0;
  for (const p of ring) { lat += p.lat; lng += p.lng; }
  return { lat: lat / n, lng: lng / n };
}

/** Simplify polygon to at most maxPoints by keeping evenly-spaced vertices. */
function simplify(ring: GeoPoint[], maxPoints: number): GeoPoint[] {
  if (ring.length <= maxPoints) return ring;
  const step = ring.length / maxPoints;
  const result: GeoPoint[] = [];
  for (let i = 0; i < maxPoints; i++) {
    result.push(ring[Math.round(i * step) % ring.length]!);
  }
  return result;
}

/** Extract a closed polygon ring from a way element (has .geometry). */
function wayToRing(el: OverpassElement): GeoPoint[] | null {
  const geom = el.geometry;
  if (!geom || geom.length < 3) return null;
  return geom.map((p) => ({ lat: p.lat, lng: p.lon }));
}

/**
 * Assemble outer ring for a multipolygon relation by chaining the outer-role
 * member way geometries into one continuous ring.
 */
function relationToRing(el: OverpassElement): GeoPoint[] | null {
  const members = el.members ?? [];
  const outers = members.filter((m) => m.role === "outer" && m.geometry && m.geometry.length > 1);
  if (!outers.length) return null;

  // Build segments
  const segments = outers.map((m) =>
    m.geometry!.map((p) => ({ lat: p.lat, lng: p.lon })),
  );

  // Chain segments greedily
  const ring: GeoPoint[] = [...segments[0]!];
  const used = new Set([0]);
  while (used.size < segments.length) {
    const tail = ring[ring.length - 1]!;
    let bestIdx = -1;
    let bestDist = Infinity;
    let reversed = false;
    for (let i = 0; i < segments.length; i++) {
      if (used.has(i)) continue;
      const seg = segments[i]!;
      const dHead = distanceMeters(tail.lat, tail.lng, seg[0]!.lat, seg[0]!.lng);
      const dTail = distanceMeters(tail.lat, tail.lng, seg[seg.length - 1]!.lat, seg[seg.length - 1]!.lng);
      if (dHead < bestDist) { bestDist = dHead; bestIdx = i; reversed = false; }
      if (dTail < bestDist) { bestDist = dTail; bestIdx = i; reversed = true; }
    }
    if (bestIdx < 0 || bestDist > 500) break; // gap too large – bail
    const seg = reversed ? [...segments[bestIdx]!].reverse() : segments[bestIdx]!;
    ring.push(...seg);
    used.add(bestIdx);
  }
  return ring.length >= 3 ? ring : null;
}

// Colour palette per place kind
const ZONE_COLORS: Record<string, string> = {
  neighbourhood: "#60a5fa",  // blue
  suburb:        "#a78bfa",  // violet
  quarter:       "#34d399",  // emerald
  district:      "#f472b6",  // pink
  borough:       "#fb923c",  // orange
  city_block:    "#facc15",  // yellow
  administrative:"#94a3b8",  // slate
};

function zoneColor(placeType: string | undefined, adminLevel: string | undefined): string {
  if (placeType && ZONE_COLORS[placeType]) return ZONE_COLORS[placeType]!;
  if (adminLevel) return ZONE_COLORS.administrative!;
  return "#60a5fa";
}

// --- Local planar geometry (equirectangular around a reference point) ------
//
// Voronoi is much cleaner in planar meters, so we project points to/from a
// local 2-D plane anchored at the streamer's position.

type Pt = { x: number; y: number };

const EARTH = 111_320;

function toMeters(refLat: number, refLng: number, g: GeoPoint): Pt {
  const cos = Math.cos((refLat * Math.PI) / 180);
  return {
    x: (g.lng - refLng) * EARTH * cos,
    y: (g.lat - refLat) * EARTH,
  };
}

function toGeo(refLat: number, refLng: number, p: Pt): GeoPoint {
  const cos = Math.cos((refLat * Math.PI) / 180);
  return {
    lat: refLat + p.y / EARTH,
    lng: refLng + p.x / (EARTH * cos),
  };
}

/**
 * Clip `polygon` (in local meters, CCW) by the perpendicular-bisector
 * half-plane that keeps only points strictly closer to `a` than to `b`.
 * Uses Sutherland–Hodgman clipping.
 *
 * Derivation of the "inside" test:
 *   keep p iff |p − a|² ≤ |p − b|²
 *   ⇔ 2·p·(b − a) ≤ |b|² − |a|²
 */
function clipHalfPlaneCloserTo(polygon: Pt[], a: Pt, b: Pt): Pt[] {
  const nx = b.x - a.x;
  const ny = b.y - a.y;
  const rhs = b.x * b.x + b.y * b.y - (a.x * a.x + a.y * a.y);
  const valueOf = (p: Pt) => 2 * (p.x * nx + p.y * ny);
  const inside = (p: Pt) => valueOf(p) <= rhs;
  const intersect = (p: Pt, q: Pt): Pt => {
    const vp = valueOf(p);
    const vq = valueOf(q);
    const denom = vq - vp;
    const t = denom === 0 ? 0 : (rhs - vp) / denom;
    return { x: p.x + t * (q.x - p.x), y: p.y + t * (q.y - p.y) };
  };

  const out: Pt[] = [];
  const n = polygon.length;
  if (n === 0) return out;
  for (let i = 0; i < n; i++) {
    const curr = polygon[i]!;
    const prev = polygon[(i + n - 1) % n]!;
    const ci = inside(curr);
    const pi = inside(prev);
    if (ci) {
      if (!pi) out.push(intersect(prev, curr));
      out.push(curr);
    } else if (pi) {
      out.push(intersect(prev, curr));
    }
  }
  return out;
}

/**
 * Build a Voronoi cell for `anchor` within `bounds` by successively clipping
 * against the perpendicular bisector with every other anchor. O(N²) overall
 * but N is small (≤ ~30 anchors in a city).
 */
function voronoiCell(anchor: Pt, others: Pt[], bounds: Pt[]): Pt[] {
  let poly = bounds.slice();
  for (const other of others) {
    if (poly.length === 0) break;
    poly = clipHalfPlaneCloserTo(poly, anchor, other);
  }
  return poly;
}

// --- Route ------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const lat = parseCoord(req.nextUrl.searchParams.get("lat"));
  const lng = parseCoord(req.nextUrl.searchParams.get("lng"));
  if (lat == null || lng == null) {
    return NextResponse.json({ error: "lat_lng_required" }, { status: 400 });
  }

  // Two queries in one Overpass request:
  // 1. Real neighbourhood/suburb/district boundary ways + relations (with full geometry)
  // 2. Tourist/historic POIs for checkpoints (nodes + way/relation centres)
  const overpassQuery = `
[out:json][timeout:25];
(
  node(around:6000,${lat},${lng})["place"~"^(neighbourhood|suburb|quarter|district|borough|city_block)$"]["name"];
  way(around:6000,${lat},${lng})["place"~"^(neighbourhood|suburb|quarter|district|borough|city_block)$"]["name"];
  relation(around:6000,${lat},${lng})["place"~"^(neighbourhood|suburb|quarter|district|borough|city_block)$"]["name"];
  relation(around:6000,${lat},${lng})["boundary"="administrative"]["admin_level"~"^(9|10|11)$"]["name"];
  node(around:4000,${lat},${lng})["tourism"~"^(attraction|museum|viewpoint|gallery|artwork|theme_park)$"]["name"];
  way(around:4000,${lat},${lng})["tourism"~"^(attraction|museum|viewpoint|gallery|theme_park)$"]["name"];
  relation(around:4000,${lat},${lng})["tourism"~"^(attraction|museum|viewpoint|gallery|theme_park)$"]["name"];
  node(around:4000,${lat},${lng})["historic"]["name"];
  node(around:4000,${lat},${lng})["amenity"~"^(theatre|cinema|place_of_worship|library|marketplace)$"]["name"];
);
out geom 120;
`;

  const response = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: {
      "Content-Type": "text/plain;charset=UTF-8",
      Accept: "application/json",
      "User-Agent": "camtok-live-map/1.0",
    },
    body: overpassQuery,
    cache: "no-store",
  }).catch(() => null);

  if (!response?.ok) {
    return NextResponse.json({ zones: [], checkpoints: [] });
  }

  const payload = (await response.json().catch(() => null)) as
    | { elements?: OverpassElement[] }
    | null;

  const elements = payload?.elements ?? [];

  // ── Zones (full-map coverage via Voronoi tessellation) ───────────────────
  //
  // Gather every real OSM place anchor near the streamer — neighbourhoods,
  // suburbs, quarters, districts, boroughs, city_blocks, plus admin-level
  // 9/10/11 boundaries. Each anchor contributes its centroid as a Voronoi
  // site. We clip the resulting tessellation against a square around the
  // streamer so the whole visible city is carved into named cells with no
  // holes and no overlaps. Each cell is labelled after the closest real
  // place, so the names stay meaningful.
  const placeAnchors = elements
    .map((el) => {
      const tags = el.tags ?? {};
      const name = tags.name;
      const placeType = tags.place;
      const adminLevel = tags.admin_level;
      if (!name) return null;
      if (!placeType && !adminLevel) return null;
      let cLat: number | null = null;
      let cLng: number | null = null;
      if (el.type === "node") {
        cLat = el.lat ?? null;
        cLng = el.lon ?? null;
      } else {
        const ring = el.type === "way" ? wayToRing(el) : relationToRing(el);
        if (ring && ring.length >= 3) {
          const c = centroid(ring);
          cLat = c.lat;
          cLng = c.lng;
        } else if (el.center) {
          cLat = el.center.lat;
          cLng = el.center.lon;
        }
      }
      if (cLat == null || cLng == null) return null;
      const dist = distanceMeters(lat, lng, cLat, cLng);
      if (dist > 15_000) return null;
      return {
        name,
        placeType: placeType ?? "administrative",
        adminLevel,
        lat: cLat,
        lng: cLng,
        dist,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => a.dist - b.dist);

  const dedupAnchors: typeof placeAnchors = [];
  const seenAnchorNames = new Set<string>();
  for (const a of placeAnchors) {
    const key = a.name.toLowerCase();
    if (seenAnchorNames.has(key)) continue;
    seenAnchorNames.add(key);
    dedupAnchors.push(a);
    if (dedupAnchors.length >= 30) break;
  }

  // Synthetic fallback anchors: if OSM returns very few places (e.g. small
  // town or rural area), sprinkle a ring around the user so we still produce
  // several cells rather than 1-3 giant ones. These get generic names.
  const fallbackAnchors: typeof placeAnchors = [];
  if (dedupAnchors.length < 6) {
    const ringRadii = [1600, 3000, 4500];
    const perRing = 6;
    let idx = 0;
    for (const r of ringRadii) {
      for (let i = 0; i < perRing; i++) {
        const angle = (Math.PI * 2 * i) / perRing + (idx * 0.37);
        const cos = Math.cos((lat * Math.PI) / 180);
        fallbackAnchors.push({
          name: `Area ${idx + 1}`,
          placeType: "administrative",
          adminLevel: "",
          lat: lat + (Math.sin(angle) * r) / EARTH,
          lng: lng + (Math.cos(angle) * r) / (EARTH * cos),
          dist: r,
        });
        idx += 1;
      }
    }
  }

  // Coverage square: 6 km radius → 12 km side. Voronoi cells are clipped to
  // this square so they don't extend to infinity.
  const coverageHalfM = 6_000;
  const bounds: Pt[] = [
    { x: -coverageHalfM, y: -coverageHalfM },
    { x:  coverageHalfM, y: -coverageHalfM },
    { x:  coverageHalfM, y:  coverageHalfM },
    { x: -coverageHalfM, y:  coverageHalfM },
  ];

  const allAnchors = [...dedupAnchors, ...fallbackAnchors];
  const anchorPts: Array<{ pt: Pt; meta: (typeof allAnchors)[number] }> = allAnchors.map((a) => ({
    pt: toMeters(lat, lng, { lat: a.lat, lng: a.lng }),
    meta: a,
  }));

  // Merge anchors that are extremely close — redundant sites would produce
  // slivers. 250 m threshold keeps micro-places out of separate cells.
  const mergedAnchors: typeof anchorPts = [];
  for (const a of anchorPts) {
    const tooClose = mergedAnchors.some((m) => {
      const dx = m.pt.x - a.pt.x;
      const dy = m.pt.y - a.pt.y;
      return Math.hypot(dx, dy) < 250;
    });
    if (!tooClose) mergedAnchors.push(a);
  }

  let zones: Array<{
    id: string;
    slug: string;
    name: string;
    kind: "district";
    color: string;
    isActive: boolean;
    polygon: GeoPoint[];
  }> = [];

  if (mergedAnchors.length === 0) {
    // Nothing to work with — emit a single coverage rectangle so the map
    // still has a tap-target layer.
    const polyGeo = bounds.map((p) => toGeo(lat, lng, p));
    zones = [{
      id: "zone-area-0",
      slug: "area",
      name: "Area",
      kind: "district",
      color: zoneColor(undefined, undefined),
      isActive: true,
      polygon: simplify(polyGeo, 36),
    }];
  } else if (mergedAnchors.length === 1) {
    const onlyAnchor = mergedAnchors[0]!;
    const polyGeo = bounds.map((p) => toGeo(lat, lng, p));
    zones = [{
      id: "zone-solo-0",
      slug: onlyAnchor.meta.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""),
      name: onlyAnchor.meta.name,
      kind: "district",
      color: zoneColor(onlyAnchor.meta.placeType, onlyAnchor.meta.adminLevel),
      isActive: true,
      polygon: simplify(polyGeo, 36),
    }];
  } else {
    const allPts = mergedAnchors.map((a) => a.pt);
    zones = mergedAnchors
      .map((anchor, i) => {
        const others = allPts.filter((_, j) => j !== i);
        const cellMeters = voronoiCell(anchor.pt, others, bounds);
        if (cellMeters.length < 3) return null;
        const polygon = cellMeters.map((p) => toGeo(lat, lng, p));
        const area = polygonAreaM2(polygon);
        if (area < 5_000) return null; // drop sliver cells < 0.005 km²
        return {
          id: `zone-v-${i}`,
          slug: anchor.meta.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/(^-|-$)/g, "") || `zone-${i}`,
          name: anchor.meta.name,
          kind: "district" as const,
          color: zoneColor(anchor.meta.placeType, anchor.meta.adminLevel),
          isActive: true,
          polygon: simplify(polygon, 48),
        };
      })
      .filter((z): z is NonNullable<typeof z> => z !== null);
  }

  // ── Checkpoints / Tourist attractions ─────────────────────────────────────

  const checkpointCandidates: Array<{
    id: string;
    name: string;
    kind: "bridge" | "square" | "landmark" | "crossing" | "poi";
    lat: number;
    lng: number;
    isActive: true;
    dist: number;
  }> = [];

  for (const el of elements) {
    const tags = el.tags ?? {};
    const name = tags.name;
    if (!name) continue;
    const tourism = tags.tourism;
    const historic = tags.historic;
    const amenity = tags.amenity;
    if (!tourism && !historic && !amenity) continue;
    // Skip elements that were already used as zones
    const placeType = tags.place;
    const adminLevel = tags.admin_level;
    if (placeType || adminLevel) continue;

    const elLat = el.lat ?? el.center?.lat;
    const elLng = el.lon ?? el.center?.lon;
    if (elLat == null || elLng == null) continue;

    const kind: "bridge" | "square" | "landmark" | "crossing" | "poi" =
      amenity === "marketplace" ? "square" :
      historic === "bridge" ? "bridge" :
      tourism === "viewpoint" || historic ? "landmark" :
      tourism === "museum" ? "poi" :
      "poi";

    checkpointCandidates.push({
      id: `cp-osm-${el.type}-${el.id}`,
      name,
      kind,
      lat: elLat,
      lng: elLng,
      isActive: true,
      dist: distanceMeters(lat, lng, elLat, elLng),
    });
  }

  const seenCheckpoints = new Map<string, (typeof checkpointCandidates)[0]>();
  for (const cp of checkpointCandidates.sort((a, b) => a.dist - b.dist)) {
    const key = cp.name.toLowerCase();
    if (!seenCheckpoints.has(key)) seenCheckpoints.set(key, cp);
  }

  const checkpoints = [...seenCheckpoints.values()].slice(0, 10).map(
    ({ dist: _dist, ...cp }) => cp,
  );

  return NextResponse.json({ zones, checkpoints });
}
