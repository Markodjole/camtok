import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Zone = {
  id: string;
  slug: string;
  name: string;
  kind: "district" | "corridor" | "mission-zone" | "restricted-zone";
  color: string;
  isActive: boolean;
  polygon: Array<{ lat: number; lng: number }>;
};

type Checkpoint = {
  id: string;
  name: string;
  kind: "bridge" | "square" | "landmark" | "crossing" | "poi";
  lat: number;
  lng: number;
  isActive: boolean;
};

type GPoint = { lat: number; lng: number };
type Pt = { x: number; y: number };
const EARTH = 111_320;

function parseCoord(value: string | null): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function colorForType(t: string): string {
  if (t.includes("neighborhood") || t.includes("sublocality")) return "#60a5fa";
  if (t.includes("locality")) return "#a78bfa";
  if (t.includes("administrative")) return "#34d399";
  return "#94a3b8";
}

function viewportToPolygon(viewport: {
  northeast: { lat: number; lng: number };
  southwest: { lat: number; lng: number };
}): Array<{ lat: number; lng: number }> {
  const ne = viewport.northeast;
  const sw = viewport.southwest;
  return [
    { lat: sw.lat, lng: sw.lng },
    { lat: sw.lat, lng: ne.lng },
    { lat: ne.lat, lng: ne.lng },
    { lat: ne.lat, lng: sw.lng },
  ];
}

function toMeters(refLat: number, refLng: number, g: GPoint): Pt {
  const cos = Math.cos((refLat * Math.PI) / 180);
  return {
    x: (g.lng - refLng) * EARTH * cos,
    y: (g.lat - refLat) * EARTH,
  };
}

function toGeo(refLat: number, refLng: number, p: Pt): GPoint {
  const cos = Math.cos((refLat * Math.PI) / 180);
  return {
    lat: refLat + p.y / EARTH,
    lng: refLng + p.x / (EARTH * cos),
  };
}

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

function voronoiCell(anchor: Pt, others: Pt[], bounds: Pt[]): Pt[] {
  let poly = bounds.slice();
  for (const other of others) {
    if (poly.length === 0) break;
    poly = clipHalfPlaneCloserTo(poly, anchor, other);
  }
  return poly;
}

export async function GET(req: NextRequest) {
  const lat = parseCoord(req.nextUrl.searchParams.get("lat"));
  const lng = parseCoord(req.nextUrl.searchParams.get("lng"));
  if (lat == null || lng == null) {
    return NextResponse.json({ error: "lat_lng_required" }, { status: 400 });
  }

  const key =
    process.env.GOOGLE_MAPS_API_KEY ||
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ||
    "";
  if (!key) {
    return NextResponse.json({
      zones: [],
      checkpoints: [],
      source: "google",
      reason: "missing_api_key",
    });
  }

  const zones: Zone[] = [];
  const checkpoints: Checkpoint[] = [];

  // 1) Reverse geocode to discover nearby admin/neighborhood labels and city viewport.
  const revUrl =
    `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${key}&language=en`;
  const rev = await fetch(revUrl, { cache: "no-store" }).then((r) => r.json()).catch(() => null) as
    | {
        status?: string;
        results?: Array<{
          formatted_address?: string;
          types?: string[];
          address_components?: Array<{ long_name?: string; types?: string[] }>;
          geometry?: {
            viewport?: {
              northeast: { lat: number; lng: number };
              southwest: { lat: number; lng: number };
            };
          };
        }>;
      }
    | null;
  if (!rev || rev.status === "REQUEST_DENIED") {
    return NextResponse.json({
      zones: [],
      checkpoints: [],
      source: "google",
      reason: "request_denied",
    });
  }

  const components = (rev?.results ?? [])
    .flatMap((r) => r.address_components ?? [])
    .filter((c) =>
      (c.types ?? []).some((t) =>
        t === "neighborhood" ||
        t === "sublocality" ||
        t === "sublocality_level_1" ||
        t === "locality" ||
        t === "administrative_area_level_2",
      ),
    );

  const uniqueAreaNames = Array.from(
    new Map(
      components
        .filter((c) => c.long_name)
        .map((c) => [c.long_name!.toLowerCase(), c]),
    ).values(),
  ).slice(0, 8);

  // Pick city-scale viewport from reverse-geocode results.
  const cityViewport =
    (rev.results ?? []).find((r) => (r.types ?? []).includes("locality"))?.geometry?.viewport ||
    (rev.results ?? []).find((r) => (r.types ?? []).includes("administrative_area_level_2"))?.geometry?.viewport ||
    (rev.results ?? [])[0]?.geometry?.viewport;
  const coverageViewport = cityViewport ?? {
    northeast: { lat: lat + 0.06, lng: lng + 0.08 },
    southwest: { lat: lat - 0.06, lng: lng - 0.08 },
  };

  // 2) Geocode each area name to create "administrative rectangles" (raw Google geometry).
  for (const c of uniqueAreaNames) {
    const name = c.long_name!;
    const t = (c.types ?? [])[0] ?? "administrative_area_level_2";
    const url =
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(name)}` +
      `&location=${lat},${lng}&key=${key}&language=en`;
    const g = await fetch(url, { cache: "no-store" }).then((r) => r.json()).catch(() => null) as
      | {
          status?: string;
          results?: Array<{
            geometry?: {
              viewport?: {
                northeast: { lat: number; lng: number };
                southwest: { lat: number; lng: number };
              };
            };
          }>;
        }
      | null;
    if (!g || g.status === "REQUEST_DENIED") continue;
    const vp = g.results?.[0]?.geometry?.viewport;
    if (!vp) continue;
    zones.push({
      id: `g-zone-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      name,
      kind: "district",
      color: colorForType(t),
      isActive: true,
      polygon: viewportToPolygon(vp),
    });
  }

  // 3) Nearby places for checkpoint-like POIs + anchor seeds for city-wide tessellation.
  const placeTypes = [
    "tourist_attraction",
    "museum",
    "park",
    "shopping_mall",
    "transit_station",
    "school",
    "hospital",
  ];
  const anchorSeeds: Array<{ id: string; name: string; lat: number; lng: number; type: string }> = [];
  for (const t of placeTypes) {
    const nearbyUrl =
      `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}` +
      `&radius=3000&type=${encodeURIComponent(t)}&key=${key}`;
    const p = await fetch(nearbyUrl, { cache: "no-store" }).then((r) => r.json()).catch(() => null) as
      | {
          status?: string;
          results?: Array<{
            place_id?: string;
            name?: string;
            geometry?: { location?: { lat: number; lng: number } };
            types?: string[];
          }>;
        }
      | null;
    if (!p || p.status === "REQUEST_DENIED") continue;
    for (const r of p?.results ?? []) {
      if (!r.place_id || !r.name || !r.geometry?.location) continue;
      const kind: Checkpoint["kind"] =
        (r.types ?? []).includes("park") ? "square" :
        (r.types ?? []).includes("tourist_attraction") ? "landmark" :
        "poi";
      checkpoints.push({
        id: `g-cp-${r.place_id}`,
        name: r.name,
        kind,
        lat: r.geometry.location.lat,
        lng: r.geometry.location.lng,
        isActive: true,
      });
      anchorSeeds.push({
        id: r.place_id,
        name: r.name,
        lat: r.geometry.location.lat,
        lng: r.geometry.location.lng,
        type: (r.types ?? [])[0] ?? t,
      });
    }
  }

  // 4) Build full-city coverage from Google anchors (Voronoi over city viewport).
  const adminAnchors = uniqueAreaNames.map((a, i) => ({
    id: `admin-${i}`,
    name: a.long_name ?? `Area ${i + 1}`,
    lat,
    lng,
    type: (a.types ?? [])[0] ?? "administrative",
  }));
  const allAnchors = [...anchorSeeds, ...adminAnchors]
    .slice(0, 60);
  const dedupAnchorMap = new Map<string, (typeof allAnchors)[number]>();
  for (const a of allAnchors) {
    if (!dedupAnchorMap.has(a.id)) dedupAnchorMap.set(a.id, a);
  }
  const anchors = Array.from(dedupAnchorMap.values());

  if (anchors.length >= 3) {
    const sw = coverageViewport.southwest;
    const ne = coverageViewport.northeast;
    const bounds: Pt[] = [
      toMeters(lat, lng, { lat: sw.lat, lng: sw.lng }),
      toMeters(lat, lng, { lat: sw.lat, lng: ne.lng }),
      toMeters(lat, lng, { lat: ne.lat, lng: ne.lng }),
      toMeters(lat, lng, { lat: ne.lat, lng: sw.lng }),
    ];
    const pts = anchors.map((a) => ({ a, p: toMeters(lat, lng, { lat: a.lat, lng: a.lng }) }));
    const cells = pts.map((row, i) => {
      const others = pts.filter((_, j) => j !== i).map((x) => x.p);
      const poly = voronoiCell(row.p, others, bounds);
      if (poly.length < 3) return null;
      const polygon = poly.map((pt) => toGeo(lat, lng, pt));
      const zone: Zone = {
        id: `g-v-${row.a.id}`,
        slug: row.a.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        name: row.a.name,
        kind: "district",
        color: colorForType(row.a.type),
        isActive: true,
        polygon,
      };
      return zone;
    }).filter((x): x is Zone => x !== null);
    zones.push(...cells);
  }

  const dedupZones = Array.from(
    new Map(zones.map((z) => [z.slug, z])).values(),
  ).slice(0, 12);
  const dedupCheckpoints = Array.from(
    new Map(checkpoints.map((c) => [c.id, c])).values(),
  ).slice(0, 16);
  return NextResponse.json({
    zones: dedupZones,
    checkpoints: dedupCheckpoints,
    source: "google",
  });
}

