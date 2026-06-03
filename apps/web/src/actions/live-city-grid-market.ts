"use server";

import { unstable_noStore } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import {
  cellIdForPosition,
  enumerateGridCells,
  parseGridOptionId,
} from "@/lib/live/grid/cityGrid500";
import { getOrBuildGridSpecForRoom } from "@/lib/live/grid/gridSpecForRoom";
import { Safety, type LiveMarketOption, type TransportMode } from "@bettok/live";
import {
  BET_OPEN_WINDOW_MS,
  BET_OPEN_WINDOW_IDLE_MS,
} from "@/lib/live/betting/betWindowConstants";
import { computeEqualOdds } from "@/lib/live/betting/marketOdds";

/**
 * `next_zone`: viewer taps a 500 m grid cell on the map to bet which square
 * the driver enters next.
 *
 * Trigger rule: fires once per cell per live session whenever the driver is
 * anywhere inside the cell (same threshold as zone_exit_time "entry").  The
 * old 100 m center gate was removed because most road paths never pass within
 * 100 m of a 500 m cell centre, so the market almost never fired.
 */
export async function openCityGridMarketForRoom(
  roomId: string,
  opts?: { windowMs?: number },
) {
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

  const cellKey = `cell:r${parsed.row}:c${parsed.col}`;

  // Once-per-cell-per-session dupe guard — only if someone actually bet last time.
  const { data: prior } = await service
    .from("live_betting_markets")
    .select("id, subtitle")
    .eq("live_session_id", sessionId)
    .eq("market_type", "city_grid")
    .order("opens_at", { ascending: false })
    .limit(30);

  const priorIds = (prior ?? []).map((row) => (row as { id: string }).id);
  const marketsWithBets = new Set<string>();
  if (priorIds.length > 0) {
    const { data: betRows } = await service
      .from("live_bets")
      .select("market_id")
      .in("market_id", priorIds);
    for (const b of betRows ?? []) {
      marketsWithBets.add((b as { market_id: string }).market_id);
    }
  }

  const alreadyFired = (prior ?? []).some((row) => {
    const r = row as { id: string; subtitle: string | null };
    if (!marketsWithBets.has(r.id)) return false;
    try {
      const meta = JSON.parse(r.subtitle ?? "{}") as { cellKey?: string };
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

  // Equal-probability odds across all grid cells (5 % margin).
  const odds = computeEqualOdds(options);

  const now = new Date();
  const windowMs = opts?.windowMs ?? BET_OPEN_WINDOW_MS;
  const locksAt = new Date(now.getTime() + windowMs);
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
      odds: odds as unknown as Record<string, unknown>,
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
