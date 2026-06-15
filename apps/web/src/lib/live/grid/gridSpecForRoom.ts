import "server-only";

import type { createServiceClient } from "@/lib/supabase/server";
import {
  buildCityGrid500,
  type CityGridSpecCompact,
} from "@/lib/live/grid/cityGrid500";
import { bboxAroundGps } from "@/lib/live/grid/gpsCityBbox";

/** In-process grid for the current server tick — GPS-derived, not Google API data. */
const GRID_SPEC_MEMORY = new Map<
  string,
  { spec: CityGridSpecCompact; builtAtMs: number }
>();

/**
 * Reuse-or-build the 500 m city grid spec for a room.
 *
 * Grid bounds are computed from driver GPS (no Google Geocoding) so the spec
 * can be persisted without violating Maps caching rules.
 */
export async function getOrBuildGridSpecForRoom(
  service: Awaited<ReturnType<typeof createServiceClient>>,
  roomId: string,
  liveSessionId: string,
): Promise<
  | { ok: true; spec: CityGridSpecCompact; source: "reused" | "built" }
  | { ok: false; error: string }
> {
  const { data: prevGrid } = await service
    .from("live_betting_markets")
    .select("city_grid_spec")
    .eq("room_id", roomId)
    .not("city_grid_spec", "is", null)
    .order("opens_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const reused =
    (prevGrid as { city_grid_spec: CityGridSpecCompact | null } | null)
      ?.city_grid_spec ?? null;
  if (reused) return { ok: true, spec: reused, source: "reused" };

  const mem = GRID_SPEC_MEMORY.get(roomId);
  if (mem) return { ok: true, spec: mem.spec, source: "built" };

  const { data: latestGps } = await service
    .from("live_route_snapshots")
    .select("normalized_lat,normalized_lng,raw_lat,raw_lng")
    .eq("live_session_id", liveSessionId)
    .order("recorded_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!latestGps) return { ok: false, error: "grid_spec: no GPS yet" };
  const g = latestGps as {
    normalized_lat: number | null;
    normalized_lng: number | null;
    raw_lat: number;
    raw_lng: number;
  };
  const lat = g.normalized_lat ?? g.raw_lat;
  const lng = g.normalized_lng ?? g.raw_lng;

  const bbox = bboxAroundGps(lat, lng);
  const built = buildCityGrid500(
    bbox.swLat,
    bbox.swLng,
    bbox.neLat,
    bbox.neLng,
    null,
    500,
    12000,
  );
  if ("error" in built) return { ok: false, error: `grid_spec: ${built.error}` };
  GRID_SPEC_MEMORY.set(roomId, { spec: built.spec, builtAtMs: Date.now() });
  return { ok: true, spec: built.spec, source: "built" };
}
