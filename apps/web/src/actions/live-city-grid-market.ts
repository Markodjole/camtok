"use server";

import { unstable_noStore } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import {
  buildCityGrid500,
  cellIdForPosition,
  enumerateGridCells,
  gridCellCenter,
  parseGridOptionId,
  type CityGridSpecCompact,
} from "@/lib/live/grid/cityGrid500";
import { fetchCityViewportFromGoogle } from "@/lib/live/grid/googleCityViewport";
import { Safety, type LiveMarketOption, type TransportMode } from "@bettok/live";
import {
  BET_OPEN_WINDOW_MS,
  ZONE_BET_CENTER_RADIUS_M,
} from "@/lib/live/betting/betWindowConstants";
import { metersBetween } from "@/lib/live/routing/geometry";

/**
 * Opens a system market whose options are 500 m × 500 m grid cells over the
 * streamer's current city viewport. No route_decision_node row — settlement
 * uses GPS point-in-cell from `city_grid_spec`.
 */
export async function openCityGridMarketForRoom(roomId: string) {
  unstable_noStore();
  const service = await createServiceClient();

  const { data: room } = await service
    .from("live_rooms")
    .select("id, live_session_id, phase, current_market_id")
    .eq("id", roomId)
    .maybeSingle();
  if (!room) return { error: "Room not found" };
  if ((room as { phase: string }).phase === "market_open") {
    return { error: "Market already open" };
  }

  const sessionId = (room as { live_session_id: string }).live_session_id;

  const { data: sessionRow } = await service
    .from("character_live_sessions")
    .select("transport_mode, character_id")
    .eq("id", sessionId)
    .maybeSingle();
  if (!sessionRow) return { error: "Session not found" };
  const transportMode = (sessionRow as { transport_mode: TransportMode }).transport_mode;
  const characterId = (sessionRow as { character_id: string }).character_id;

  const { data: characterRow } = await service
    .from("characters")
    .select("name")
    .eq("id", characterId)
    .maybeSingle();
  const characterName = (characterRow as { name: string } | null)?.name ?? "character";

  const policy = Safety.policyFor(transportMode);
  if (!policy.allowSystemMarkets) {
    return { error: "System markets disabled for this mode" };
  }

  const { data: recent } = await service
    .from("live_route_snapshots")
    .select("recorded_at, normalized_lat, normalized_lng, raw_lat, raw_lng")
    .eq("live_session_id", sessionId)
    .order("recorded_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!recent) {
    return { error: "Not enough route data yet" };
  }
  const lat =
    (recent as { normalized_lat: number | null }).normalized_lat ??
    (recent as { raw_lat: number }).raw_lat;
  const lng =
    (recent as { normalized_lng: number | null }).normalized_lng ??
    (recent as { raw_lng: number }).raw_lng;

  /**
   * Reuse the most recent grid spec for this room so the cell boundaries stay
   * stable between markets — otherwise the inner-100-m circle that gates
   * `next_zone` would shift every time the geocode rebuilt the viewport, and
   * the driver could "leave the circle" without actually moving.
   */
  let spec: CityGridSpecCompact | null = null;
  {
    const { data: prevGrid } = await service
      .from("live_betting_markets")
      .select("city_grid_spec")
      .eq("room_id", roomId)
      .eq("market_type", "city_grid")
      .not("city_grid_spec", "is", null)
      .order("opens_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    spec = (prevGrid as { city_grid_spec: CityGridSpecCompact | null } | null)
      ?.city_grid_spec ?? null;
  }

  if (!spec) {
    const key =
      process.env.GOOGLE_MAPS_API_KEY ||
      process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ||
      "";
    if (!key) {
      return { error: "City grid: missing Google API key" };
    }

    const vp = await fetchCityViewportFromGoogle(lat, lng, key);
    if (!vp.ok) {
      return { error: `City grid: geocode ${vp.status}` };
    }

    const { viewport } = vp;
    const built = buildCityGrid500(
      viewport.swLat,
      viewport.swLng,
      viewport.neLat,
      viewport.neLng,
      viewport.cityLabel,
      500,
      12000,
    );
    if ("error" in built) {
      return { error: `City grid: ${built.error}` };
    }
    spec = built.spec;
  }

  /**
   * Inner-circle gate — `next_zone` only opens while the driver is within
   * `ZONE_BET_CENTER_RADIUS_M` of their current cell center. Otherwise the
   * bet-card popup would advertise picking a square while the driver is
   * already standing next to an edge about to cross out of it (which is the
   * exact case the user flagged as broken).
   */
  const currentCellId = cellIdForPosition(spec, lat, lng);
  if (!currentCellId) {
    return { error: "Zone gate: driver outside grid bounds" };
  }
  {
    const parsed = parseGridOptionId(currentCellId);
    if (!parsed) return { error: "Zone gate: bad cell id" };
    const center = gridCellCenter(spec, parsed.row, parsed.col);
    const dist = metersBetween({ lat, lng }, center);
    if (dist > ZONE_BET_CENTER_RADIUS_M) {
      return {
        error: `next_zone: ${Math.round(dist)} m from cell center > ${ZONE_BET_CENTER_RADIUS_M} m`,
      };
    }
  }

  /** Enumerate cells from spec — fresh build path's `cells` list is no longer used. */
  const cells = enumerateGridCells(spec);
  const options: LiveMarketOption[] = cells.map((c, i) => ({
    id: c.id,
    label: c.label,
    shortLabel: c.label,
    displayOrder: i,
  }));

  const cityLabel = spec.cityLabel ?? "this area";
  const title = `Which square will ${characterName} enter first?`;
  const subtitle = `500 m grid · ${cityLabel}`;

  const now = new Date();
  const opensAt = now;
  /**
   * 7-second bet window (product rule: "every bet stays on screen 7 seconds
   * or until viewer bets, whichever sooner"). After the window closes the
   * tick force-locks the market and immediately rotates to the next bet.
   * Settlement waits for an actual cell crossing — `reveal_at` is just a
   * generous safety timeout so a stuck driver does not hold the market
   * locked forever.
   */
  const locksAt = new Date(now.getTime() + BET_OPEN_WINDOW_MS);
  const revealAt = new Date(now.getTime() + 10 * 60_000);

  const { data: market, error: marketError } = await service
    .from("live_betting_markets")
    .insert({
      room_id: roomId,
      live_session_id: sessionId,
      decision_node_id: null,
      source: "system_generated",
      title,
      subtitle,
      market_type: "city_grid",
      option_set: options,
      city_grid_spec: spec as unknown as Record<string, unknown>,
      opens_at: opensAt.toISOString(),
      locks_at: locksAt.toISOString(),
      reveal_at: revealAt.toISOString(),
      status: "open",
      turn_point_lat: null,
      turn_point_lng: null,
    })
    .select("*")
    .single();
  if (marketError || !market) {
    return { error: marketError?.message ?? "market_insert_failed" };
  }

  await service
    .from("live_rooms")
    .update({
      phase: "market_open",
      current_market_id: market.id,
      last_event_at: now.toISOString(),
    })
    .eq("id", roomId);

  await service.from("live_room_events").insert({
    room_id: roomId,
    market_id: market.id,
    event_type: "market_open",
    payload: {
      title,
      optionCount: options.length,
      marketKind: "city_grid",
    },
  });

  return { marketId: market.id as string };
}
