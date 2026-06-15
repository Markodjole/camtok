import { NextRequest, NextResponse } from "next/server";
import { buildCityGrid500 } from "@/lib/live/grid/cityGrid500";
import { bboxAroundGps } from "@/lib/live/grid/gpsCityBbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseCoord(value: string | null): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function GET(req: NextRequest) {
  const lat = parseCoord(req.nextUrl.searchParams.get("lat"));
  const lng = parseCoord(req.nextUrl.searchParams.get("lng"));
  if (lat == null || lng == null) {
    return NextResponse.json({ error: "lat_lng_required" }, { status: 400 });
  }

  const bbox = bboxAroundGps(lat, lng);
  const built = buildCityGrid500(
    bbox.swLat,
    bbox.swLng,
    bbox.neLat,
    bbox.neLng,
    null,
    500,
    12000,
  );
  if ("error" in built) {
    return NextResponse.json({
      squares: [],
      cityLabel: null,
      cellMeters: 500,
      source: "city_grid",
      reason: built.error,
    });
  }

  return NextResponse.json({
    squares: built.cells,
    cityLabel: null,
    cellMeters: 500,
    bbox: {
      sw: { lat: bbox.swLat, lng: bbox.swLng },
      ne: { lat: bbox.neLat, lng: bbox.neLng },
    },
    gridSpec: built.spec,
    checkpoints: [],
    source: "city_grid",
    reason: "ok",
  });
}
