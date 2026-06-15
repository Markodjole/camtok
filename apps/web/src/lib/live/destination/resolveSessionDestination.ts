import "server-only";

import type { createServiceClient } from "@/lib/supabase/server";
import { fetchPlaceCoordinatesById } from "@/lib/google/resolvePlaceCoordinates";
import { isGoogleLatLngExpired } from "@/lib/google/mapsCachingPolicy";

export type SessionDestination = {
  lat: number;
  lng: number;
  label: string;
  placeId: string | null;
};

type SessionDestinationRow = {
  destination_lat: number | null;
  destination_lng: number | null;
  destination_label: string | null;
  destination_place_id: string | null;
  destination_google_coords_at: string | null;
};

/**
 * Resolve a live-session destination for routing / map display.
 * place_id is kept indefinitely; Google-sourced lat/lng are refreshed after 30 days.
 */
export async function resolveSessionDestination(
  service: Awaited<ReturnType<typeof createServiceClient>>,
  sessionId: string,
  row: SessionDestinationRow,
): Promise<SessionDestination | null> {
  const placeId = row.destination_place_id;
  const label =
    (row.destination_label ?? "").trim() || (placeId ? "Destination" : "");

  const lat = row.destination_lat;
  const lng = row.destination_lng;
  const coordsAt = row.destination_google_coords_at;

  const hasCoords =
    lat != null &&
    lng != null &&
    Number.isFinite(lat) &&
    Number.isFinite(lng);

  const googleSourced = coordsAt != null;
  const coordsFresh = hasCoords && (!googleSourced || !isGoogleLatLngExpired(coordsAt));

  if (coordsFresh) {
    return { lat: lat!, lng: lng!, label, placeId };
  }

  // Map pin without place_id — user coordinates, not a Google cache.
  if (!placeId && hasCoords) {
    return { lat: lat!, lng: lng!, label, placeId: null };
  }

  if (!placeId) return null;

  const fresh = await fetchPlaceCoordinatesById(placeId);
  if (!fresh) {
    return hasCoords ? { lat: lat!, lng: lng!, label, placeId } : null;
  }

  const nowIso = new Date().toISOString();
  await service
    .from("character_live_sessions")
    .update({
      destination_lat: fresh.lat,
      destination_lng: fresh.lng,
      destination_label: fresh.label || label,
      destination_google_coords_at: nowIso,
    })
    .eq("id", sessionId);

  return {
    lat: fresh.lat,
    lng: fresh.lng,
    label: fresh.label || label,
    placeId,
  };
}

/** Purge Google-sourced coordinates older than 30 days (scheduled / on-read hygiene). */
export async function purgeExpiredGoogleDestinationCoords(
  service: Awaited<ReturnType<typeof createServiceClient>>,
): Promise<void> {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
  await service
    .from("character_live_sessions")
    .update({
      destination_lat: null,
      destination_lng: null,
    })
    .not("destination_google_coords_at", "is", null)
    .lt("destination_google_coords_at", cutoff);
}
