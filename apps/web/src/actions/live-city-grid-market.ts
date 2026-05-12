"use server";

import { unstable_noStore } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import {
  cellIdForPosition,
  gridCellCenter,
  parseGridOptionId,
} from "@/lib/live/grid/cityGrid500";
import { getOrBuildGridSpecForRoom } from "@/lib/live/grid/gridSpecForRoom";
import { Safety, type LiveMarketOption, type TransportMode } from "@bettok/live";
import {
  BET_OPEN_WINDOW_MS,
  ZONE_BET_CENTER_RADIUS_M,
} from "@/lib/live/betting/betWindowConstants";
import { metersBetween } from "@/lib/live/routing/geometry";

/**
 * `next_zone`: bet on the CARDINAL DIRECTION (N / E / S / W) the driver
 * leaves their current 500 m grid cell. Renders in the same one-touch
 * `MapSelectionBottomSheet` as the other two bets so every market looks and
 * behaves identically.
 *
 * Gates:
 *   - Driver must be within `ZONE_BET_CENTER_RADIUS_M` (100 m) of the
 *     current cell center.
 *   - Do not reopen if a `next_zone` market was already created while the
 *     driver was in this same cell — the user explicitly asked that this
 *     bet fires once per zone, not repeatedly inside it.
 *
 * Settlement (in `live-settlement.ts`):
 *   - When the driver crosses into a different cell, derive the dominant
 *     cardinal direction from the row/column delta and pay out the matching
 *     option.
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
  const transportMode = (sessionRow as { transport_mode: TransportMode })
    .transport_mode;
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
  const characterName =
    (characterRow as { name: string } | null)?.name ?? "character";

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
  if (!currentCellId) {
    return { error: "Zone gate: driver outside grid bounds" };
  }
  const parsed = parseGridOptionId(currentCellId);
  if (!parsed) return { error: "Zone gate: bad cell id" };

  const center = gridCellCenter(spec, parsed.row, parsed.col);
  const dist = metersBetween({ lat, lng }, center);
  if (dist > ZONE_BET_CENTER_RADIUS_M) {
    return {
      error: `next_zone: ${Math.round(dist)} m from cell center > ${ZONE_BET_CENTER_RADIUS_M} m`,
    };
  }

  /**
   * Dupe guard: skip if a `next_zone` market for THIS cell already exists in
   * the recent room history. The driver has to physically enter a new cell
   * before this bet returns to the rotation.
   */
  const cellKey = `cell:r${parsed.row}:c${parsed.col}`;
  {
    const { data: prior } = await service
      .from("live_betting_markets")
      .select("subtitle")
      .eq("room_id", roomId)
      .eq("market_type", "city_grid")
      .order("opens_at", { ascending: false })
      .limit(8);
    const dupe = (prior ?? []).some((row) => {
      try {
        const meta = JSON.parse(
          (row as { subtitle: string | null }).subtitle ?? "{}",
        ) as { cellKey?: string };
        return meta.cellKey === cellKey;
      } catch {
        return false;
      }
    });
    if (dupe) {
      return { error: `next_zone: cell ${cellKey} already bet` };
    }
  }

  /**
   * 4 cardinal directions. The viewer taps one option in the same bottom
   * sheet used by the other two bet types. Order is fixed N → E → S → W so
   * the rendered row is always the same.
   */
  const options: LiveMarketOption[] = [
    { id: "north", label: "North", shortLabel: "North", displayOrder: 0 },
    { id: "east", label: "East", shortLabel: "East", displayOrder: 1 },
    { id: "south", label: "South", shortLabel: "South", displayOrder: 2 },
    { id: "west", label: "West", shortLabel: "West", displayOrder: 3 },
  ];

  const title = `Which way does ${characterName} leave this zone?`;
  const subtitle = JSON.stringify({
    cellKey,
    startRow: parsed.row,
    startCol: parsed.col,
    cityLabel: spec.cityLabel ?? null,
  });

  const now = new Date();
  const locksAt = new Date(now.getTime() + BET_OPEN_WINDOW_MS);
  /**
   * `reveal_at` is just a safety timeout — the tick settles the market the
   * moment the driver enters a different cell (see `driverCrossedCell`).
   * Keep it generous so a stuck driver doesn't refund the bet by accident.
   */
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
    payload: {
      title,
      optionCount: options.length,
      marketKind: "city_grid",
      cellKey,
    },
  });

  return { marketId: market.id as string };
}
