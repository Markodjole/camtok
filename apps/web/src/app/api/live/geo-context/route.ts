import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type OverpassElement = {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};

function parseCoord(value: string | null): number | null {
  if (!value) return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return num;
}

function metersToLat(meters: number): number {
  return meters / 111_320;
}

function metersToLng(meters: number, lat: number): number {
  return meters / (111_320 * Math.cos((lat * Math.PI) / 180));
}

function buildHexPolygon(lat: number, lng: number, radiusM: number): Array<{ lat: number; lng: number }> {
  const points: Array<{ lat: number; lng: number }> = [];
  for (let i = 0; i < 6; i += 1) {
    const angle = (Math.PI / 3) * i;
    const dx = Math.cos(angle) * radiusM;
    const dy = Math.sin(angle) * radiusM;
    points.push({
      lat: lat + metersToLat(dy),
      lng: lng + metersToLng(dx, lat),
    });
  }
  return points;
}

function distanceMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const r = 6_371_000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const aa =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((aLat * Math.PI) / 180) *
      Math.cos((bLat * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
  return r * c;
}

export async function GET(req: NextRequest) {
  const lat = parseCoord(req.nextUrl.searchParams.get("lat"));
  const lng = parseCoord(req.nextUrl.searchParams.get("lng"));
  if (lat == null || lng == null) {
    return NextResponse.json({ error: "lat_lng_required" }, { status: 400 });
  }

  const overpassQuery = `
[out:json][timeout:20];
(
  node(around:3500,${lat},${lng})["place"~"neighbourhood|suburb|quarter"];
  node(around:3500,${lat},${lng})["tourism"~"attraction|museum|viewpoint|gallery|artwork"];
  way(around:3500,${lat},${lng})["tourism"~"attraction|museum|viewpoint|gallery|artwork"];
  relation(around:3500,${lat},${lng})["tourism"~"attraction|museum|viewpoint|gallery|artwork"];
  node(around:3500,${lat},${lng})["historic"];
);
out center 80;
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

  const zoneCandidates = elements
    .map((element) => {
      const tags = element.tags ?? {};
      const placeType = tags.place;
      const name = tags.name;
      const latValue = element.lat ?? element.center?.lat;
      const lngValue = element.lon ?? element.center?.lon;
      if (!name || !placeType || latValue == null || lngValue == null) return null;
      const dist = distanceMeters(lat, lng, latValue, lngValue);
      return {
        id: `zone-osm-${element.type}-${element.id}`,
        slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""),
        name,
        kind: "district" as const,
        color: "#60a5fa",
        isActive: true,
        lat: latValue,
        lng: lngValue,
        dist,
      };
    })
    .filter((zone): zone is NonNullable<typeof zone> => zone !== null)
    .sort((a, b) => a.dist - b.dist);

  const usedZoneNames = new Set<string>();
  const zones = zoneCandidates
    .filter((zone) => {
      const key = zone.name.toLowerCase();
      if (usedZoneNames.has(key)) return false;
      usedZoneNames.add(key);
      return true;
    })
    .slice(0, 3)
    .map((zone, index) => ({
      id: zone.id,
      slug: zone.slug || `zone-${index + 1}`,
      name: zone.name,
      kind: zone.kind,
      color: zone.color,
      isActive: true,
      polygon: buildHexPolygon(zone.lat, zone.lng, 170 + index * 40),
    }));

  const checkpointCandidates = elements
    .map((element) => {
      const tags = element.tags ?? {};
      const name = tags.name;
      const latValue = element.lat ?? element.center?.lat;
      const lngValue = element.lon ?? element.center?.lon;
      const tourism = tags.tourism;
      const historic = tags.historic;
      if (!name || latValue == null || lngValue == null) return null;
      if (!tourism && !historic) return null;
      const kind: "bridge" | "square" | "landmark" | "crossing" | "poi" =
        tourism === "viewpoint" || historic ? "landmark" : tourism === "museum" ? "poi" : "poi";
      return {
        id: `cp-osm-${element.type}-${element.id}`,
        name,
        kind,
        lat: latValue,
        lng: lngValue,
        isActive: true,
        dist: distanceMeters(lat, lng, latValue, lngValue),
      };
    })
    .filter((checkpoint): checkpoint is NonNullable<typeof checkpoint> => checkpoint !== null)
    .sort((a, b) => a.dist - b.dist);

  const usedCheckpointNames = new Set<string>();
  const checkpoints = checkpointCandidates
    .filter((checkpoint) => {
      const key = checkpoint.name.toLowerCase();
      if (usedCheckpointNames.has(key)) return false;
      usedCheckpointNames.add(key);
      return true;
    })
    .slice(0, 8)
    .map(({ dist: _dist, ...checkpoint }) => checkpoint);

  return NextResponse.json({ zones, checkpoints });
}
