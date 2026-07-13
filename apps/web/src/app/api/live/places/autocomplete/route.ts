import { NextRequest, NextResponse } from "next/server";
import { assertApiAllowed } from "@/lib/usage/apiUsage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Suggestion = {
  placeId: string;
  primary: string;
  secondary: string | null;
  fullText: string;
  /** Present for Nominatim hits — client can resolve without Places Details. */
  lat?: number;
  lng?: number;
  source?: "nominatim" | "google";
};

const NOMINATIM_UA =
  "CamTok/1.0 (live destination search; contact: support@camtok.app)";

function splitDisplayName(displayName: string): {
  primary: string;
  secondary: string | null;
} {
  const parts = displayName
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length <= 1) return { primary: displayName, secondary: null };
  return { primary: parts[0]!, secondary: parts.slice(1, 4).join(", ") || null };
}

async function searchNominatim(
  input: string,
  lat: number,
  lng: number,
): Promise<Suggestion[]> {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", input);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "6");
  url.searchParams.set("addressdetails", "1");
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    const d = 0.35;
    url.searchParams.set(
      "viewbox",
      `${lng - d},${lat + d},${lng + d},${lat - d}`,
    );
  }

  const res = await fetch(url.toString(), {
    cache: "no-store",
    headers: {
      "User-Agent": NOMINATIM_UA,
      Accept: "application/json",
    },
  });
  if (!res.ok) return [];

  const rows = (await res.json()) as Array<{
    place_id?: number;
    lat?: string;
    lon?: string;
    display_name?: string;
    name?: string;
  }>;

  return rows
    .filter((r) => r.place_id != null && r.lat && r.lon && r.display_name)
    .map((r) => {
      const fullText = r.display_name!;
      const labeled =
        r.name && !fullText.startsWith(r.name)
          ? `${r.name}, ${fullText}`
          : fullText;
      const { primary, secondary } = splitDisplayName(labeled);
      return {
        placeId: `osm:${r.place_id}`,
        primary,
        secondary,
        fullText,
        lat: Number(r.lat),
        lng: Number(r.lon),
        source: "nominatim" as const,
      };
    })
    .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng));
}

/**
 * Destination autocomplete:
 * 1. Nominatim (free, server-side UA — React Native cannot call OSM directly)
 * 2. Google Places only if Nominatim empty and API guard allows it
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const input = (params.get("input") ?? "").trim();
  const lat = Number(params.get("lat"));
  const lng = Number(params.get("lng"));
  const sessionToken = params.get("sessionToken") ?? undefined;

  if (input.length < 2) {
    return NextResponse.json({ suggestions: [] satisfies Suggestion[] });
  }

  try {
    const nominatim = await searchNominatim(input, lat, lng);
    if (nominatim.length > 0) {
      return NextResponse.json({ suggestions: nominatim, source: "nominatim" });
    }
  } catch {
    // fall through to Google
  }

  const key =
    process.env.GOOGLE_MAPS_API_KEY ??
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ??
    "";
  if (!key) {
    return NextResponse.json(
      { suggestions: [], reason: "missing_api_key" },
      { status: 200 },
    );
  }

  const url = new URL(
    "https://maps.googleapis.com/maps/api/place/autocomplete/json",
  );
  url.searchParams.set("input", input);
  url.searchParams.set("key", key);
  url.searchParams.set("language", "en");
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    url.searchParams.set("location", `${lat},${lng}`);
    url.searchParams.set("radius", "30000");
  }
  if (sessionToken) url.searchParams.set("sessiontoken", sessionToken);

  const guard = assertApiAllowed("google_places_autocomplete");
  if (!guard.allowed) {
    return NextResponse.json(
      { suggestions: [], reason: guard.reason },
      { status: 200 },
    );
  }

  try {
    const res = await fetch(url.toString(), { cache: "no-store" });
    if (!res.ok) {
      return NextResponse.json(
        { suggestions: [], reason: `http_${res.status}` },
        { status: 200 },
      );
    }
    const json = (await res.json()) as {
      status?: string;
      predictions?: Array<{
        place_id?: string;
        description?: string;
        structured_formatting?: {
          main_text?: string;
          secondary_text?: string;
        };
      }>;
      error_message?: string;
    };
    if (json.status && json.status !== "OK" && json.status !== "ZERO_RESULTS") {
      return NextResponse.json(
        {
          suggestions: [],
          reason: json.status,
          message: json.error_message ?? null,
        },
        { status: 200 },
      );
    }
    const suggestions: Suggestion[] = (json.predictions ?? [])
      .filter((p) => Boolean(p.place_id) && Boolean(p.description))
      .slice(0, 6)
      .map((p) => ({
        placeId: p.place_id as string,
        primary: p.structured_formatting?.main_text ?? p.description!,
        secondary: p.structured_formatting?.secondary_text ?? null,
        fullText: p.description as string,
        source: "google" as const,
      }));
    return NextResponse.json({ suggestions, source: "google" });
  } catch (err) {
    return NextResponse.json(
      {
        suggestions: [],
        reason: "exception",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 200 },
    );
  }
}
