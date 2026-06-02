import "server-only";

import type { createServiceClient } from "@/lib/supabase/server";
import { getDriverDestinationRoute } from "@/lib/live/routing/googleRouteCache";
import { googleRoutesDisabled } from "@/lib/live/routing/googleRouteGuard";
import type { DrivingRouteStyle } from "@/lib/live/routing/drivingRouteStyle";
import type { LatLng } from "@/lib/live/routing/geometry";

/**
 * Slow-lane Google route refresh — called from the server tick (~1 Hz).
 * Warms the shared cache so viewer destination-route polls are cache hits.
 */
export async function refreshGoogleRouteForRoom(
  service: Awaited<ReturnType<typeof createServiceClient>>,
  roomId: string,
  sessionId: string,
  driver: LatLng,
): Promise<void> {
  if (googleRoutesDisabled()) return;

  const { data: session } = await service
    .from("character_live_sessions")
    .select("destination_lat, destination_lng, transport_mode, character_id")
    .eq("id", sessionId)
    .maybeSingle();
  if (!session) return;

  const destLat = (session as { destination_lat: number | null }).destination_lat;
  const destLng = (session as { destination_lng: number | null }).destination_lng;
  if (destLat == null || destLng == null) return;

  const characterId = (session as { character_id: string }).character_id;
  const transportMode =
    (session as { transport_mode: string | null }).transport_mode ?? undefined;

  let drivingRouteStyle = null;
  const { data: character } = await service
    .from("characters")
    .select("driving_route_style")
    .eq("id", characterId)
    .maybeSingle();
  if (character) {
    drivingRouteStyle = (character as { driving_route_style: unknown }).driving_route_style;
  }

  await getDriverDestinationRoute(
    roomId,
    driver,
    { lat: destLat, lng: destLng },
    {
      transportMode: transportMode ?? undefined,
      drivingRouteStyle: drivingRouteStyle as DrivingRouteStyle | null,
      checkOffRoute: true,
    },
  );
}
