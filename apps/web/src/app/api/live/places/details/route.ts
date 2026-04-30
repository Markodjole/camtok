import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Resolve a Google Places `place_id` (or arbitrary `lat,lng`) into a
 * concrete destination point we can persist on the session.
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
      destination: { lat, lng, label: `${lat.toFixed(5)}, ${lng.toFixed(5)}`, placeId: null },
      reason: "missing_api_key",
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
