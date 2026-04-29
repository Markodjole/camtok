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

function debugFallback(lat: number, lng: number): { zones: Zone[]; checkpoints: Checkpoint[] } {
  const dLat = 0.0028;
  const dLng = 0.0038;
  return {
    zones: [
      {
        id: "dbg-zone-1",
        slug: "debug-north",
        name: "Debug North",
        kind: "district",
        color: "#60a5fa",
        isActive: true,
        polygon: [
          { lat: lat + dLat * 1.2, lng: lng - dLng * 0.9 },
          { lat: lat + dLat * 1.2, lng: lng + dLng * 0.9 },
          { lat: lat + dLat * 0.2, lng: lng + dLng * 0.9 },
          { lat: lat + dLat * 0.2, lng: lng - dLng * 0.9 },
        ],
      },
      {
        id: "dbg-zone-2",
        slug: "debug-south",
        name: "Debug South",
        kind: "district",
        color: "#a78bfa",
        isActive: true,
        polygon: [
          { lat: lat - dLat * 0.2, lng: lng - dLng * 1.1 },
          { lat: lat - dLat * 0.2, lng: lng + dLng * 1.1 },
          { lat: lat - dLat * 1.2, lng: lng + dLng * 1.1 },
          { lat: lat - dLat * 1.2, lng: lng - dLng * 1.1 },
        ],
      },
    ],
    checkpoints: [
      { id: "dbg-cp-1", name: "Debug POI A", kind: "poi", lat: lat + dLat * 0.4, lng: lng + dLng * 0.4, isActive: true },
      { id: "dbg-cp-2", name: "Debug POI B", kind: "landmark", lat: lat - dLat * 0.5, lng: lng - dLng * 0.5, isActive: true },
    ],
  };
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
  const fallbackToOsm = async (reason: string) => {
    const origin = req.nextUrl.origin;
    const url = `${origin}/api/live/geo-context?lat=${lat}&lng=${lng}`;
    const res = await fetch(url, { cache: "no-store" }).catch(() => null);
    if (!res?.ok) {
      return NextResponse.json({
        zones: [],
        checkpoints: [],
        source: "google",
        reason,
      });
    }
    const j = (await res.json().catch(() => null)) as
      | {
          zones?: Zone[];
          checkpoints?: Checkpoint[];
        }
      | null;
    const zones = Array.isArray(j?.zones) ? j!.zones : [];
    const checkpoints = Array.isArray(j?.checkpoints) ? j!.checkpoints : [];
    if (zones.length === 0 && checkpoints.length === 0) {
      const dbg = debugFallback(lat, lng);
      return NextResponse.json({
        zones: dbg.zones,
        checkpoints: dbg.checkpoints,
        source: "debug_fallback",
        reason,
      });
    }
    return NextResponse.json({
      zones,
      checkpoints,
      source: "osm_fallback",
      reason,
    });
  };
  if (!key) {
    return fallbackToOsm("missing_api_key");
  }

  const zones: Zone[] = [];
  const checkpoints: Checkpoint[] = [];

  // 1) Reverse geocode to discover nearby admin/neighborhood labels.
  const revUrl =
    `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${key}&language=en`;
  const rev = await fetch(revUrl, { cache: "no-store" }).then((r) => r.json()).catch(() => null) as
    | {
        results?: Array<{
          address_components?: Array<{ long_name?: string; types?: string[] }>;
        }>;
      }
    | null;

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

  // 2) Geocode each area name with location bias and convert viewport bounds to polygons.
  for (const c of uniqueAreaNames) {
    const name = c.long_name!;
    const t = (c.types ?? [])[0] ?? "administrative_area_level_2";
    const url =
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(name)}` +
      `&location=${lat},${lng}&key=${key}&language=en`;
    const g = await fetch(url, { cache: "no-store" }).then((r) => r.json()).catch(() => null) as
      | {
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
    const vp = g?.results?.[0]?.geometry?.viewport;
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

  // 3) Nearby places for checkpoint-like POIs.
  const placeTypes = ["tourist_attraction", "museum", "park", "shopping_mall"];
  for (const t of placeTypes) {
    const nearbyUrl =
      `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}` +
      `&radius=3000&type=${encodeURIComponent(t)}&key=${key}`;
    const p = await fetch(nearbyUrl, { cache: "no-store" }).then((r) => r.json()).catch(() => null) as
      | {
          results?: Array<{
            place_id?: string;
            name?: string;
            geometry?: { location?: { lat: number; lng: number } };
            types?: string[];
          }>;
        }
      | null;
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
    }
  }

  const dedupZones = Array.from(
    new Map(zones.map((z) => [z.slug, z])).values(),
  ).slice(0, 12);
  const dedupCheckpoints = Array.from(
    new Map(checkpoints.map((c) => [c.id, c])).values(),
  ).slice(0, 16);
  if (dedupZones.length === 0 && dedupCheckpoints.length === 0) {
    return fallbackToOsm("google_empty");
  }
  return NextResponse.json({
    zones: dedupZones,
    checkpoints: dedupCheckpoints,
    source: "google",
  });
}

