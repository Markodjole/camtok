import "server-only";

import type { createServiceClient } from "@/lib/supabase/server";
import {
  buildCityGrid500,
  type CityGridSpecCompact,
} from "@/lib/live/grid/cityGrid500";
import { fetchCityViewportFromGoogle } from "@/lib/live/grid/googleCityViewport";

/**
 * Reuse-or-build the 500 m city grid spec for a room.
 *
 * The grid spec is room-scoped and effectively permanent for the session —
 * every zone bet (`next_zone` AND `zone_exit_time`) needs to know "which
 * 500 m square is the driver in right now", so both openers call this.
 *
 * Resolution order:
 *   1. Reuse the spec from the most recent `city_grid` market in this room.
 *   2. Build a new one by geocoding the driver's latest GPS via Google.
 *
 * Returns `{ ok: false, error }` when neither path can produce a spec
 * (no GPS yet, missing Google key, or geocode failure) so callers can skip
 * eligibility without erroring loudly.
 */
export async function getOrBuildGridSpecForRoom(
  service: Awaited<ReturnType<typeof createServiceClient>>,
  roomId: string,
  liveSessionId: string,
): Promise<
  | { ok: true; spec: CityGridSpecCompact; source: "reused" | "built" }
  | { ok: false; error: string }
> {
  /**
   * Any market row in this room with a non-null `city_grid_spec` is fair
   * game for reuse — both `next_zone` and `zone_exit_time` write the spec
   * back so the second-ever zone bet doesn't have to round-trip Google.
   */
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

  const key =
    process.env.GOOGLE_MAPS_API_KEY ||
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ||
    "";
  if (!key) return { ok: false, error: "grid_spec: missing Google API key" };

  const vp = await fetchCityViewportFromGoogle(lat, lng, key);
  if (!vp.ok) return { ok: false, error: `grid_spec: geocode ${vp.status}` };
  const built = buildCityGrid500(
    vp.viewport.swLat,
    vp.viewport.swLng,
    vp.viewport.neLat,
    vp.viewport.neLng,
    vp.viewport.cityLabel,
    500,
    12000,
  );
  if ("error" in built) return { ok: false, error: `grid_spec: ${built.error}` };
  return { ok: true, spec: built.spec, source: "built" };
}
