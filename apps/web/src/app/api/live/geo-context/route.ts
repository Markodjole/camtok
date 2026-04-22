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

function radialPolygon(lat: number, lng: number, radiusM: number, points = 10): GeoPoint[] {
  const out: GeoPoint[] = [];
  for (let i = 0; i < points; i++) {
    const angle = (Math.PI * 2 * i) / points;
    const dy = (Math.sin(angle) * radiusM) / 111_320;
    const dx = (Math.cos(angle) * radiusM) / (111_320 * Math.cos((lat * Math.PI) / 180));
    out.push({ lat: lat + dy, lng: lng + dx });
  }
  return out;
}

function offsetMeters(lat: number, lng: number, dxMeters: number, dyMeters: number): GeoPoint {
  const dy = dyMeters / 111_320;
  const dx = dxMeters / (111_320 * Math.cos((lat * Math.PI) / 180));
  return { lat: lat + dy, lng: lng + dx };
}

function sectorPolygon(
  lat: number,
  lng: number,
  startRad: number,
  endRad: number,
  outerRadiusM: number,
  arcSteps = 8,
): GeoPoint[] {
  const ring: GeoPoint[] = [{ lat, lng }];
  for (let i = 0; i <= arcSteps; i++) {
    const t = i / arcSteps;
    const a = startRad + (endRad - startRad) * t;
    const dx = Math.cos(a) * outerRadiusM;
    const dy = Math.sin(a) * outerRadiusM;
    ring.push(offsetMeters(lat, lng, dx, dy));
  }
  return ring;
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

  // ── Zones (full-map coverage using real place anchors) ───────────────────
  // We use real OSM place names/centers, then generate contiguous sectors that
  // cover the visible map area around the streamer so there are no "holes".
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
    if (dedupAnchors.length >= 18) break;
  }

  const sectorCount = Math.max(6, Math.min(12, dedupAnchors.length || 6));
  const coverageRadiusM = 2600;
  const zones = Array.from({ length: sectorCount }, (_, idx) => {
    const a0 = (Math.PI * 2 * idx) / sectorCount;
    const a1 = (Math.PI * 2 * (idx + 1)) / sectorCount;
    const mid = (a0 + a1) / 2;
    const probe = offsetMeters(lat, lng, Math.cos(mid) * 900, Math.sin(mid) * 900);
    const nearest =
      dedupAnchors.length > 0
        ? dedupAnchors.reduce((best, cur) => {
            const db = distanceMeters(probe.lat, probe.lng, best.lat, best.lng);
            const dc = distanceMeters(probe.lat, probe.lng, cur.lat, cur.lng);
            return dc < db ? cur : best;
          })
        : null;
    const name = nearest?.name ?? `Zone ${idx + 1}`;
    const placeType = nearest?.placeType;
    const adminLevel = nearest?.adminLevel;
    return {
      id: `zone-cover-${idx}`,
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""),
      name,
      kind: "district" as const,
      color: zoneColor(placeType, adminLevel),
      isActive: true,
      polygon: simplify(sectorPolygon(lat, lng, a0, a1, coverageRadiusM, 10), 36),
    };
  });

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
