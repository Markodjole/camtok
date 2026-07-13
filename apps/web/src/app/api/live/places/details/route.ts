import { NextRequest, NextResponse } from "next/server";
import { assertApiAllowed } from "@/lib/usage/apiUsage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NOMINATIM_UA =
  "CamTok/1.0 (live destination search; contact: support@camtok.app)";

async function resolveOsmPlaceId(osmPlaceId: string): Promise<{
  lat: number;
  lng: number;
  label: string;
} | null> {
  const id = osmPlaceId.replace(/^osm:/i, "").trim();
  if (!id) return null;
  const url = new URL("https://nominatim.openstreetmap.org/details");
  url.searchParams.set("place_id", id);
  url.searchParams.set("format", "json");
  try {
    const res = await fetch(url.toString(), {
      cache: "no-store",
      headers: { "User-Agent": NOMINATIM_UA, Accept: "application/json" },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      centroid?: { coordinates?: [number, number] };
      localname?: string;
      names?: { name?: string };
      addresstags?: Record<string, string>;
    };
    const coords = json.centroid?.coordinates;
    if (!coords || coords.length < 2) return null;
    const [lng, lat] = coords;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const label =
      json.localname ||
      json.names?.name ||
      Object.values(json.addresstags ?? {})[0] ||
      `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    return { lat, lng, label };
  } catch {
    return null;
  }
}

/**
 * Resolve a place into a concrete destination point.
 * - Google `place_id` → Places Details (when allowed)
 * - `osm:*` → Nominatim details
 * - lat/lng → reverse geocode (optional)
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const placeId = params.get("placeId");
  const sessionToken = params.get("sessionToken") ?? undefined;
  const latRaw = params.get("lat");
  const lngRaw = params.get("lng");

  const key =
    process.env.GOOGLE_MAPS_API_KEY ??
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ??
    "";

  if (placeId) {
    // Free OSM path — never send osm: IDs to Google.
    if (placeId.startsWith("osm:")) {
      const osm = await resolveOsmPlaceId(placeId);
      if (!osm) {
        return NextResponse.json(
          { destination: null, reason: "osm_lookup_failed" },
          { status: 200 },
        );
      }
      return NextResponse.json({
        destination: {
          lat: osm.lat,
          lng: osm.lng,
          label: osm.label,
          placeId: null,
        },
      });
    }

    if (!key) {
      return NextResponse.json(
        { destination: null, reason: "missing_api_key" },
        { status: 200 },
      );
    }
    const url = new URL(
      "https://maps.googleapis.com/maps/api/place/details/json",
    );
    url.searchParams.set("place_id", placeId);
    url.searchParams.set("key", key);
    url.searchParams.set("language", "en");
    url.searchParams.set("fields", "name,formatted_address,geometry/location");
    if (sessionToken) url.searchParams.set("sessiontoken", sessionToken);

    const guard = assertApiAllowed("google_places_details");
    if (!guard.allowed) {
      return NextResponse.json(
        { destination: null, reason: guard.reason },
        { status: 200 },
      );
    }

    try {
      const res = await fetch(url.toString(), { cache: "no-store" });
      const json = (await res.json()) as {
        status?: string;
        result?: {
          name?: string;
          formatted_address?: string;
          geometry?: { location?: { lat?: number; lng?: number } };
        };
        error_message?: string;
      };
      const loc = json.result?.geometry?.location;
      if (
        json.status !== "OK" ||
        !loc ||
        typeof loc.lat !== "number" ||
        typeof loc.lng !== "number"
      ) {
        return NextResponse.json(
          {
            destination: null,
            reason: json.status ?? "unknown",
            message: json.error_message ?? null,
          },
          { status: 200 },
        );
      }
      return NextResponse.json({
        destination: {
          lat: loc.lat,
          lng: loc.lng,
          label:
            json.result?.name ??
            json.result?.formatted_address ??
            "Destination",
          placeId,
        },
      });
    } catch (err) {
      return NextResponse.json(
        {
          destination: null,
          reason: "exception",
          message: err instanceof Error ? err.message : String(err),
        },
        { status: 200 },
      );
    }
  }

  // Reverse-geocode path (used by "Pick on map").
  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json(
      { destination: null, reason: "missing_input" },
      { status: 400 },
    );
  }
  if (!key) {
    return NextResponse.json({
      destination: {
        lat,
        lng,
        label: `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
        placeId: null,
      },
      reason: "missing_api_key",
    });
  }
  const geoGuard = assertApiAllowed("google_geocode");
  if (!geoGuard.allowed) {
    return NextResponse.json({
      destination: {
        lat,
        lng,
        label: `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
        placeId: null,
      },
      reason: geoGuard.reason,
    });
  }

  try {
    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set("latlng", `${lat},${lng}`);
    url.searchParams.set("key", key);
    url.searchParams.set("language", "en");
    const res = await fetch(url.toString(), { cache: "no-store" });
    const json = (await res.json()) as {
      status?: string;
      results?: Array<{ formatted_address?: string; place_id?: string }>;
    };
    const first = json.results?.[0];
    return NextResponse.json({
      destination: {
        lat,
        lng,
        label:
          first?.formatted_address ?? `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
        placeId: first?.place_id ?? null,
      },
    });
  } catch {
    return NextResponse.json({
      destination: {
        lat,
        lng,
        label: `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
        placeId: null,
      },
    });
  }
}
