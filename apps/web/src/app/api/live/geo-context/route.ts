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

  // ── Zones ─────────────────────────────────────────────────────────────────

  const zoneCandidates: Array<{
    id: string;
    name: string;
    placeType: string;
    color: string;
    polygon: GeoPoint[];
    dist: number;
  }> = [];

  for (const el of elements) {
    const tags = el.tags ?? {};
    const name = tags.name;
    const placeType = tags.place;
    const adminLevel = tags.admin_level;
    // Must have a name and be a boundary-type element
    if (!name) continue;
    if (!placeType && !adminLevel) continue;

    let ring: GeoPoint[] | null = null;
    if (el.type === "way") {
      ring = wayToRing(el);
    } else if (el.type === "relation") {
      ring = relationToRing(el);
      // Fallback: use bounds rectangle if member geometry is missing
      if (!ring && el.bounds) {
        const { minlat, minlon, maxlat, maxlon } = el.bounds;
        ring = [
          { lat: minlat, lng: minlon },
          { lat: maxlat, lng: minlon },
          { lat: maxlat, lng: maxlon },
          { lat: minlat, lng: maxlon },
        ];
      }
    }
    if (!ring || ring.length < 3) continue;

    // Filter out polygons that are absurdly large (> 50 km²) or tiny (< 0.005 km²)
    const area = polygonAreaM2(ring);
    if (area > 50_000_000 || area < 5_000) continue;

    const center = centroid(ring);
    const dist = distanceMeters(lat, lng, center.lat, center.lng);

    // Must overlap or be very close – centroid within 7 km
    if (dist > 7_000) continue;

    zoneCandidates.push({
      id: `zone-osm-${el.type}-${el.id}`,
      name,
      placeType: placeType ?? "administrative",
      color: zoneColor(placeType, adminLevel),
      polygon: simplify(ring, 48), // keep detail but cap points
      dist,
    });
  }

  // Deduplicate by name, keep closest
  const seenZones = new Map<string, (typeof zoneCandidates)[0]>();
  for (const z of zoneCandidates.sort((a, b) => a.dist - b.dist)) {
    const key = z.name.toLowerCase();
    if (!seenZones.has(key)) seenZones.set(key, z);
  }

  const zones = [...seenZones.values()].slice(0, 8).map((z) => ({
    id: z.id,
    slug: z.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""),
    name: z.name,
    kind: "district" as const,
    color: z.color,
    isActive: true,
    polygon: z.polygon,
  }));

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
