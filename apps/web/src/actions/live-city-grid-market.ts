"use server";

import { unstable_noStore } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import {
  cellIdForPosition,
  enumerateGridCells,
  gridCellCenter,
  parseGridOptionId,
} from "@/lib/live/grid/cityGrid500";
import { getOrBuildGridSpecForRoom } from "@/lib/live/grid/gridSpecForRoom";
import { Safety, type LiveMarketOption, type TransportMode } from "@bettok/live";
import {
  BET_OPEN_WINDOW_MS,
  NEXT_ZONE_TRIGGER_M,
} from "@/lib/live/betting/betWindowConstants";
import { metersBetween } from "@/lib/live/routing/geometry";

/**
 * `next_zone`: viewer taps a 500 m grid cell on the map to bet which square
 * the driver enters next.
 *
 * Trigger rule (the only gate):
 *   Driver must be within NEXT_ZONE_TRIGGER_M (100 m) of the current cell
 *   center. This fires at most once per zone cell visit (dupe guard checks
 *   the last 30 markets for this room).
 */
export async function openCityGridMarketForRoom(roomId: string) {
  unstable_noStore();
  const service = await createServiceClient();

  const { data: room } = await service
    .from("live_rooms")
    .select("id, live_session_id, phase")
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

  const policy = Safety.policyFor(transportMode);
  if (!policy.allowSystemMarkets) {
    return { error: "System markets disabled for this mode" };
  }

  const { data: characterRow } = await service
    .from("characters")
    .select("name")
    .eq("id", characterId)
    .maybeSingle();
  const characterName = (characterRow as { name: string } | null)?.name ?? "character";

  const { data: latestGps } = await service
    .from("live_route_snapshots")
    .select("normalized_lat,normalized_lng,raw_lat,raw_lng")
    .eq("live_session_id", sessionId)
    .order("recorded_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!latestGps) return { error: "Not enough route data yet" };
  const g = latestGps as {
    normalized_lat: number | null;
    normalized_lng: number | null;
    raw_lat: number;
    raw_lng: number;
  };
  const lat = g.normalized_lat ?? g.raw_lat;
  const lng = g.normalized_lng ?? g.raw_lng;

  const specRes = await getOrBuildGridSpecForRoom(service, roomId, sessionId);
  if (!specRes.ok) return { error: specRes.error };
  const spec = specRes.spec;

  const currentCellId = cellIdForPosition(spec, lat, lng);
  if (!currentCellId) return { error: "next_zone: driver outside grid bounds" };
  const parsed = parseGridOptionId(currentCellId);
  if (!parsed) return { error: "next_zone: bad cell id" };

  const center = gridCellCenter(spec, parsed.row, parsed.col);
  const dist = metersBetween({ lat, lng }, center);
  if (dist > NEXT_ZONE_TRIGGER_M) {
    return {
      error: `next_zone: ${Math.round(dist)} m from cell center > ${NEXT_ZONE_TRIGGER_M} m`,
    };
  }

  const cellKey = `cell:r${parsed.row}:c${parsed.col}`;

  // Once-per-cell dupe guard: check the last 30 city_grid markets for this room.
  const { data: prior } = await service
    .from("live_betting_markets")
    .select("subtitle")
    .eq("room_id", roomId)
    .eq("market_type", "city_grid")
    .order("opens_at", { ascending: false })
    .limit(30);
  const alreadyFired = (prior ?? []).some((row) => {
    try {
      const meta = JSON.parse(
        (row as { subtitle: string | null }).subtitle ?? "{}",
      ) as { cellKey?: string };
      return meta.cellKey === cellKey;
    } catch {
      return false;
    }
  });
  if (alreadyFired) {
    return { error: `next_zone: cell ${cellKey} already bet in this visit` };
  }

  const cells = enumerateGridCells(spec);
  const options: LiveMarketOption[] = cells.map((c, i) => ({
    id: c.id,
    label: c.label,
    shortLabel: c.label,
    displayOrder: i,
  }));

  const title = `Which square will ${characterName} enter first?`;
  const subtitle = JSON.stringify({
    cellKey,
    startRow: parsed.row,
    startCol: parsed.col,
    cityLabel: spec.cityLabel ?? null,
  });

  const now = new Date();
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
      opens_at: now.toISOString(),
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
    payload: { title, optionCount: options.length, marketKind: "city_grid", cellKey },
  });

  return { marketId: market.id as string };
}
