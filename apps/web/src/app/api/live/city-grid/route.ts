import { NextRequest, NextResponse } from "next/server";
import { buildCityGrid500 } from "@/lib/live/grid/cityGrid500";
import { fetchCityViewportFromGoogle } from "@/lib/live/grid/googleCityViewport";

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

  const key =
    process.env.GOOGLE_MAPS_API_KEY ||
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ||
    "";
  if (!key) {
    return NextResponse.json({
      squares: [],
      cityLabel: null,
      cellMeters: 500,
      source: "city_grid",
      reason: "missing_api_key",
    });
  }

  const vp = await fetchCityViewportFromGoogle(lat, lng, key);
  if (!vp.ok) {
    return NextResponse.json({
      squares: [],
      cityLabel: null,
      cellMeters: 500,
      source: "city_grid",
      reason: "geocode_failed",
      googleStatus: vp.status,
      googleError: vp.message,
    });
  }

  const { viewport } = vp;
  const built = buildCityGrid500(
    viewport.swLat,
    viewport.swLng,
    viewport.neLat,
    viewport.neLng,
    viewport.cityLabel,
    500,
    12000,
  );
  if ("error" in built) {
    return NextResponse.json({
      squares: [],
      cityLabel: viewport.cityLabel,
      cellMeters: 500,
      source: "city_grid",
      reason: built.error,
    });
  }

  return NextResponse.json({
    squares: built.cells,
    cityLabel: viewport.cityLabel,
    cellMeters: 500,
    bbox: {
      sw: { lat: viewport.swLat, lng: viewport.swLng },
      ne: { lat: viewport.neLat, lng: viewport.neLng },
    },
    gridSpec: built.spec,
    checkpoints: [],
    source: "city_grid",
    reason: "ok",
  });
}
