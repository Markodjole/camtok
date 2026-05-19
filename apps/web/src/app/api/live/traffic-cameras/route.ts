import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type TrafficCamera = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  imageUrl: string | null;
  /** True when within ACTIVE_RADIUS_M of driver and roughly ahead. */
  isNearest: boolean;
  distanceM: number;
};

/**
 * Windy Webcams API v3 — 60k+ global webcams, free key at api.windy.com/keys.
 * Image URLs are signed and expire after 10 min (free tier) — the client
 * re-fetches this endpoint every 20 s so they stay fresh.
 * Set WINDY_API_KEY in env; no key → returns empty list gracefully.
 */
const WINDY_BASE = "https://api.windy.com/webcams/api/v3/webcams";
const SEARCH_RADIUS_KM = 2.5;
/** Cameras inside this distance show the feed panel. */
const ACTIVE_RADIUS_M = 800;
/** Half-angle of the forward heading cone. */
const FORWARD_CONE_DEG = 80;

function bearingDeg(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
): number {
  const dLng = ((toLng - fromLng) * Math.PI) / 180;
  const φ1 = (fromLat * Math.PI) / 180;
  const φ2 = (toLat * Math.PI) / 180;
  const y = Math.sin(dLng) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function angleDiff(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

function distanceM(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const lat = parseFloat(searchParams.get("lat") ?? "");
  const lng = parseFloat(searchParams.get("lng") ?? "");
  const heading = parseFloat(searchParams.get("heading") ?? "0");

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ cameras: [] });
  }

  const apiKey = process.env.WINDY_API_KEY ?? "YBwaeM2uROZILBibNH0vwaunrjSmTkQh";


  try {
    const url = new URL(WINDY_BASE);
    // nearby={lat},{lng},{radius_km}
    url.searchParams.set("nearby", `${lat},${lng},${SEARCH_RADIUS_KM}`);
    url.searchParams.set("limit", "30");
    // include images so we get the current snapshot URL in one call
    url.searchParams.set("include", "images");
    url.searchParams.set("lang", "en");

    const res = await fetch(url.toString(), {
      headers: { "x-windy-api-key": apiKey },
      // Windy free-tier image URLs expire in 10 min — short cache so URLs stay fresh.
      next: { revalidate: 20 },
    });

    if (!res.ok) {
      console.warn("[traffic-cameras] Windy error", res.status, await res.text().catch(() => ""));
      return NextResponse.json({ cameras: [] });
    }

    const json = (await res.json()) as {
      webcams?: Array<{
        webcamId?: string;
        id?: string;
        title?: string;
        location?: { latitude?: number; longitude?: number; city?: string };
        images?: {
          current?: {
            preview?: string;
            large?: string;
          };
        };
      }>;
    };

    const raw = json.webcams ?? [];

    const cameras: TrafficCamera[] = raw
      .map((w) => {
        const cLat = w.location?.latitude ?? 0;
        const cLng = w.location?.longitude ?? 0;
        const dist = distanceM(lat, lng, cLat, cLng);
        const bear = bearingDeg(lat, lng, cLat, cLng);
        const diff = angleDiff(bear, heading);
        const imageUrl = w.images?.current?.large ?? w.images?.current?.preview ?? null;
        return {
          id: w.webcamId ?? w.id ?? String(Math.random()),
          name: w.title ?? w.location?.city ?? "Webcam",
          lat: cLat,
          lng: cLng,
          imageUrl,
          isNearest: false,
          distanceM: dist,
          _diff: diff,
        };
      })
      .filter((c) => c._diff < FORWARD_CONE_DEG && c.lat !== 0 && c.lng !== 0)
      .sort((a, b) => a.distanceM - b.distanceM)
      .slice(0, 8)
      .map((c, i) => ({
        id: c.id,
        name: c.name,
        lat: c.lat,
        lng: c.lng,
        imageUrl: c.imageUrl,
        isNearest: i === 0 && c.distanceM <= ACTIVE_RADIUS_M,
        distanceM: c.distanceM,
      }));

    return NextResponse.json({ cameras });
  } catch (err) {
    console.warn("[traffic-cameras] fetch error", err);
    return NextResponse.json({ cameras: [] });
  }
}
