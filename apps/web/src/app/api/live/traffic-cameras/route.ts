import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type TrafficCamera = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  direction: string | null;
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
// Windy's nearby filter is quirky at exactly 2.5 km (returns 0 in Belgrade); 3 km is reliable.
const SEARCH_RADIUS_KM = 3;
/** Cameras within this distance AND most aligned to heading show the feed panel. */
const ACTIVE_RADIUS_M = 1500;
/** Half-angle of the heading cone for feed activation — camera must be roughly ahead. */
const FEED_CONE_DEG = 90;

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
    // include images AND location — without location, lat/lng are missing from the response
    url.searchParams.set("include", "images,location");
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
        webcamId?: number | string;
        title?: string;
        location?: { latitude?: number; longitude?: number; city?: string };
        images?: {
          current?: {
            preview?: string;
            thumbnail?: string;
          };
        };
      }>;
    };

    const raw = json.webcams ?? [];

    type Enriched = {
      id: string; name: string; lat: number; lng: number;
      direction: null; imageUrl: string | null;
      isNearest: boolean; distanceM: number; _diff: number;
    };

    const enriched: Enriched[] = raw
      .map((w) => {
        const cLat = w.location?.latitude ?? 0;
        const cLng = w.location?.longitude ?? 0;
        if (cLat === 0 && cLng === 0) return null;
        const dist = distanceM(lat, lng, cLat, cLng);
        const bear = bearingDeg(lat, lng, cLat, cLng);
        const diff = angleDiff(bear, heading);
        // Windy v3 only returns preview (400×224) — no separate "large"
        const imageUrl = w.images?.current?.preview ?? w.images?.current?.thumbnail ?? null;
        return {
          id: w.webcamId != null ? String(w.webcamId) : String(Math.random()),
          name: w.title ?? w.location?.city ?? "Webcam",
          lat: cLat, lng: cLng, direction: null as null,
          imageUrl, isNearest: false, distanceM: dist, _diff: diff,
        };
      })
      .filter((c): c is Enriched => c !== null)
      .sort((a, b) => a.distanceM - b.distanceM)
      .slice(0, 10);

    // Feed activation: pick the camera most directly ahead within ACTIVE_RADIUS_M.
    // "Most directly ahead" = smallest angleDiff within the forward cone.
    const feedCandidates = enriched.filter(
      (c) => c.distanceM <= ACTIVE_RADIUS_M && c._diff <= FEED_CONE_DEG,
    );
    feedCandidates.sort((a, b) => a._diff - b._diff);
    const feedCamId = feedCandidates[0]?.id ?? null;

    const cameras: TrafficCamera[] = enriched.map((c) => ({
      id: c.id, name: c.name, lat: c.lat, lng: c.lng,
      direction: c.direction, imageUrl: c.imageUrl,
      isNearest: c.id === feedCamId,
      distanceM: c.distanceM,
    }));

    return NextResponse.json({ cameras });
  } catch (err) {
    console.warn("[traffic-cameras] fetch error", err);
    return NextResponse.json({ cameras: [] });
  }
}
