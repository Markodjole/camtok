import "server-only";

import { assertApiAllowed } from "@/lib/usage/apiUsage";

export type ResolvedPlaceCoordinates = {
  lat: number;
  lng: number;
  label: string;
  placeId: string;
};

/** Fresh Places Details fetch — do not persist the response beyond session rules. */
export async function fetchPlaceCoordinatesById(
  placeId: string,
): Promise<ResolvedPlaceCoordinates | null> {
  const key =
    process.env.GOOGLE_MAPS_API_KEY ??
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ??
    "";
  if (!key) return null;

  const guard = assertApiAllowed("google_places_details");
  if (!guard.allowed) return null;

  const url = new URL("https://maps.googleapis.com/maps/api/place/details/json");
  url.searchParams.set("place_id", placeId);
  url.searchParams.set("key", key);
  url.searchParams.set("language", "en");
  url.searchParams.set("fields", "name,formatted_address,geometry/location");

  try {
    const res = await fetch(url.toString(), { cache: "no-store" });
    const json = (await res.json()) as {
      status?: string;
      result?: {
        name?: string;
        formatted_address?: string;
        geometry?: { location?: { lat?: number; lng?: number } };
      };
    };
    const loc = json.result?.geometry?.location;
    if (
      json.status !== "OK" ||
      !loc ||
      typeof loc.lat !== "number" ||
      typeof loc.lng !== "number"
    ) {
      return null;
    }
    return {
      lat: loc.lat,
      lng: loc.lng,
      label:
        json.result?.name ??
        json.result?.formatted_address ??
        "Destination",
      placeId,
    };
  } catch {
    return null;
  }
}
