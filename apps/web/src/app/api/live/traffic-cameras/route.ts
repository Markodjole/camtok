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
  videoUrl: string | null;
  /** True when this camera is the active one shown in the feed panel. */
  isNearest: boolean;
  distanceM: number;
};

/**
 * TfL JamCam API — ~900 London traffic cameras, no API key required.
 * Provides both JPEG images and short MP4 clips (updated every ~10 s).
 */
const TFL_BASE = "https://api.tfl.gov.uk/Place/Type/JamCam";

/** Search radius around driver position to filter cameras. */
const SEARCH_RADIUS_M = 3000;
/** Half-angle cone for feed activation. */
const FEED_CONE_DEG = 90;
/** Feed activates when camera is within this route distance ahead. */
const ACTIVE_RADIUS_M = 1500;

function bearingDeg(fromLat: number, fromLng: number, toLat: number, toLng: number): number {
  const dLng = ((toLng - fromLng) * Math.PI) / 180;
  const φ1 = (fromLat * Math.PI) / 180;
  const φ2 = (toLat * Math.PI) / 180;
  const y = Math.sin(dLng) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function angleDiff(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

function distanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

type TflCamera = {
  id: string;
  commonName: string;
  lat: number;
  lon: number;
  additionalProperties: Array<{ key: string; value: string }>;
};

let tflCacheData: TflCamera[] | null = null;
let tflCacheAt = 0;
const TFL_CACHE_MS = 5 * 60_000; // 5 minutes — camera list rarely changes

async function fetchTflCameras(): Promise<TflCamera[]> {
  const now = Date.now();
  if (tflCacheData && now - tflCacheAt < TFL_CACHE_MS) return tflCacheData;

  const res = await fetch(TFL_BASE, { next: { revalidate: 300 } });
  if (!res.ok) throw new Error(`TfL API ${res.status}`);

  const data = (await res.json()) as TflCamera[];
  tflCacheData = data;
  tflCacheAt = now;
  return data;
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const lat = parseFloat(searchParams.get("lat") ?? "");
  const lng = parseFloat(searchParams.get("lng") ?? "");
  const heading = parseFloat(searchParams.get("heading") ?? "0");

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ cameras: [] });
  }

  try {
    const all = await fetchTflCameras();

    type Enriched = TrafficCamera & { _diff: number };

    const enriched: Enriched[] = all
      .map((c) => {
        const cLat = c.lat;
        const cLng = c.lon;
        if (!Number.isFinite(cLat) || !Number.isFinite(cLng)) return null;

        const dist = distanceM(lat, lng, cLat, cLng);
        if (dist > SEARCH_RADIUS_M) return null;

        const props = Object.fromEntries(c.additionalProperties.map((p) => [p.key, p.value]));
        if (props.available === "false") return null;

        const bear = bearingDeg(lat, lng, cLat, cLng);
        const diff = angleDiff(bear, heading);

        return {
          id: c.id,
          name: c.commonName,
          lat: cLat,
          lng: cLng,
          direction: props.view ?? null,
          imageUrl: props.imageUrl ?? null,
          videoUrl: props.videoUrl ?? null,
          isNearest: false,
          distanceM: dist,
          _diff: diff,
        };
      })
      .filter((c): c is Enriched => c !== null)
      .sort((a, b) => a.distanceM - b.distanceM)
      .slice(0, 10);

    // Feed activation: most directly ahead within ACTIVE_RADIUS_M.
    const feedCandidates = enriched.filter(
      (c) => c.distanceM <= ACTIVE_RADIUS_M && c._diff <= FEED_CONE_DEG,
    );
    feedCandidates.sort((a, b) => a._diff - b._diff);
    const feedCamId = feedCandidates[0]?.id ?? null;

    const cameras: TrafficCamera[] = enriched.map((c) => ({
      id: c.id,
      name: c.name,
      lat: c.lat,
      lng: c.lng,
      direction: c.direction,
      imageUrl: c.imageUrl,
      videoUrl: c.videoUrl,
      isNearest: c.id === feedCamId,
      distanceM: c.distanceM,
    }));

    return NextResponse.json({ cameras });
  } catch (err) {
    console.warn("[traffic-cameras] TfL fetch error", err);
    return NextResponse.json({ cameras: [] });
  }
}
