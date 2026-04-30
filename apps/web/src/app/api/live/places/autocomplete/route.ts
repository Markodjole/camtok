import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Suggestion = {
  placeId: string;
  primary: string;
  secondary: string | null;
  fullText: string;
};

/**
 * Server-side proxy to Google Places Autocomplete. Keeps the API key
 * private and lets us bias results toward the driver's current GPS so
 * "town hall" or "main square" pulls up the right city.
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
      }));
    return NextResponse.json({ suggestions });
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
