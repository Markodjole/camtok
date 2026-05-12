import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { openCityGridMarketForRoom } from "@/actions/live-city-grid-market";
import {
  openEngineMarketForRoom,
  shouldSettleEngineMarket,
} from "@/actions/live-engine-market";
import { openNextTurnMarketForRoom } from "@/actions/live-next-turn-market";
import { lockMarket, revealAndSettleMarket } from "@/actions/live-settlement";
import { isEngineMarketType } from "@/lib/live/betting/engineMarketOptions";
import {
  cellIdForPosition,
  type CityGridSpecCompact,
} from "@/lib/live/grid/cityGrid500";

/**
 * Per-room state machine driver.
 *
 * Rotation (today): only 3 bet types are offered to viewers —
 *   1. `next_turn`   — left / straight / right at the upcoming pin
 *   2. `next_zone`   — pick a grid square the driver enters next (city_grid)
 *   3. `zone_exit_time` — how long before they leave the current zone
 *
 * Each market lives 7 s as the visible / bettable market (`opens_at` →
 * `locks_at`). When `locks_at` passes we force-lock and **immediately move
 * the room back to `waiting_for_next_market`** so the very next tick opens
 * another bet. The previously-locked market keeps existing in the DB and is
 * settled in the background once its natural per-type event fires
 * (cell crossing for `next_zone`, zone exit for `zone_exit_time`, pin pass
 * for `next_turn`).
 *
 * Idempotent: state-machine guards every transition.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROTATION_TYPES = ["next_turn", "next_zone", "zone_exit_time"] as const;

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ roomId: string }> },
) {
  const { roomId } = await ctx.params;
  const service = await createServiceClient();

  /**
   * Try to settle every still-locked market in this room on every tick —
   * decoupled from the rotation so the next bet can open immediately when
   * the previous one's 7 s window expires.
   */
  const settleNotes = await sweepPendingSettlements(service, roomId);

  const { data: room } = await service
    .from("live_rooms")
    .select("id, phase, current_market_id")
    .eq("id", roomId)
    .maybeSingle();
  if (!room) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const phase = (room as { phase: string }).phase;
  const marketId =
    (room as { current_market_id: string | null }).current_market_id;

  if (phase === "market_open" && marketId) {
    const { data: market } = await service
      .from("live_betting_markets")
      .select("id, status, opens_at, locks_at, market_type")
      .eq("id", marketId)
      .maybeSingle();
    if (market) {
      const status = (market as { status: string }).status;
      const mType = (market as { market_type: string }).market_type;
      const locksAtMs = new Date(
        (market as { locks_at: string }).locks_at,
      ).getTime();
      const nowMs = Date.now();
      /**
       * Stale-market eviction: only the 3 active bet types (`next_turn`,
       * `next_zone`, `zone_exit_time`) are allowed in front of the viewer.
       * Anything else (a `time_vs_google` row from before this rewrite, an
       * old `next_direction` system market, etc.) is force-locked + cleared
       * so the next tick opens one of the 3 supported bets.
       */
      const isActiveRotationType =
        mType === "next_turn" ||
        mType === "city_grid" ||
        mType === "zone_exit_time";
      const shouldLockNow =
        status === "open" && (nowMs >= locksAtMs || !isActiveRotationType);
      if (shouldLockNow) {
        const lockResult = await lockMarket(marketId);
        /**
         * Race-safety: multiple viewers POST `/tick` concurrently. Only the
         * tick that actually transitioned the market (open → locked) clears
         * `current_market_id`. Losers see `{ error: "Market not open" }`
         * and must not blindly clear the pointer, or they will erase the
         * **next** market a winning tick has already opened — which is what
         * was causing the bet card to flash on screen for a split second.
         */
        if ("commitHash" in lockResult) {
          await service
            .from("live_rooms")
            .update({
              phase: "waiting_for_next_market",
              current_market_id: null,
              last_event_at: new Date().toISOString(),
            })
            .eq("id", roomId)
            // Extra guard: only clear when we're still the current market.
            .eq("current_market_id", marketId);
        }
        // Fall through to the "waiting" branch below so the same tick can
        // also open the next market without a 1.5 s round-trip wait.
      }
    }
  }

  // Re-read phase after the possible transition above.
  const { data: room2 } = await service
    .from("live_rooms")
    .select("phase")
    .eq("id", roomId)
    .maybeSingle();
  const phaseNow = (room2 as { phase: string } | null)?.phase ?? phase;

  if (phaseNow === "waiting_for_next_market") {
    const opened = await openNextRotationMarket(service, roomId);
    return NextResponse.json({
      action: opened.action,
      ...(opened.detail ?? {}),
      settled: settleNotes,
    });
  }

  /**
   * Legacy `market_locked` phase — old markets created before this rewrite
   * may still be here. Force them through settlement so the room can move.
   */
  if (phaseNow === "market_locked" && marketId) {
    const r = await revealAndSettleMarket(marketId);
    return NextResponse.json({
      action: "legacy_locked_settle",
      ...r,
      settled: settleNotes,
    });
  }

  return NextResponse.json({
    action: "noop",
    phase: phaseNow,
    settled: settleNotes,
  });
}

/**
 * Pick the next bet type to offer based on per-type eligibility and the
 * most-recent rotation history, then open it. Returns the action label that
 * the tick sends back to the viewer for debugging.
 */
async function openNextRotationMarket(
  service: Awaited<ReturnType<typeof createServiceClient>>,
  roomId: string,
): Promise<{ action: string; detail?: Record<string, unknown> }> {
  /**
   * Round-robin: walk the rotation list starting from one after whichever
   * type was opened most recently in this room. Each opener has its own
   * eligibility gate (pin distance for `next_turn`, ≤100 m from cell center
   * for the two zone bets) and returns `{ error }` when not ready. We try
   * every type in order before giving up so the room never sits idle when
   * any bet is offerable.
   */
  const { data: recent } = await service
    .from("live_betting_markets")
    .select("market_type")
    .eq("room_id", roomId)
    .order("opens_at", { ascending: false })
    .limit(1);
  const lastType =
    ((recent ?? [])[0] as { market_type?: string } | undefined)?.market_type ??
    null;
  const startIdx = lastType
    ? Math.max(0, ROTATION_TYPES.indexOf(lastType as (typeof ROTATION_TYPES)[number]))
    : -1;

  const reasons: Array<{ type: string; reason: string }> = [];
  for (let step = 1; step <= ROTATION_TYPES.length; step += 1) {
    const idx = (startIdx + step + ROTATION_TYPES.length) % ROTATION_TYPES.length;
    const type = ROTATION_TYPES[idx]!;
    const res = await openByType(type, roomId);
    if ("marketId" in res && res.marketId) {
      return {
        action: `opened_${type}`,
        detail: { marketId: res.marketId, attempts: reasons },
      };
    }
    if ("error" in res) reasons.push({ type, reason: res.error ?? "?" });
  }
  return { action: "no_eligible_bet", detail: { attempts: reasons } };
}

async function openByType(
  type: (typeof ROTATION_TYPES)[number],
  roomId: string,
) {
  switch (type) {
    case "next_turn":
      return openNextTurnMarketForRoom(roomId);
    case "next_zone":
      return openCityGridMarketForRoom(roomId);
    case "zone_exit_time":
      return openEngineMarketForRoom(roomId);
  }
}

/**
 * Iterate every still-locked market in this room and settle the ones whose
 * natural event has fired. Each market type has its own resolution:
 *
 *   - `next_zone` (city_grid)    → driver entered a different cell
 *   - `zone_exit_time` (engine)  → driver left the captured zone
 *   - `next_turn`                → driver committed past the pin
 *                                  (handled by RouteState path matching
 *                                   inside `revealAndSettleMarket`)
 *
 * Any market whose `reveal_at` has elapsed is force-settled as a fallback so
 * orphan rows don't pile up forever.
 */
async function sweepPendingSettlements(
  service: Awaited<ReturnType<typeof createServiceClient>>,
  roomId: string,
): Promise<Array<{ marketId: string; reason: string }>> {
  const { data: locked } = await service
    .from("live_betting_markets")
    .select(
      "id, status, opens_at, locks_at, reveal_at, market_type, city_grid_spec, lock_evidence_json, live_session_id, turn_point_lat, turn_point_lng, subtitle",
    )
    .eq("room_id", roomId)
    .eq("status", "locked")
    .limit(20);

  const notes: Array<{ marketId: string; reason: string }> = [];
  const nowMs = Date.now();

  for (const row of locked ?? []) {
    const mid = (row as { id: string }).id;
    const marketType = (row as { market_type: string }).market_type;
    const locksAtStr = (row as { locks_at: string }).locks_at;
    const revealAtMs = new Date((row as { reveal_at: string }).reveal_at).getTime();
    const sessionId = (row as { live_session_id: string | null })
      .live_session_id;
    const opensAtStr = (row as { opens_at: string }).opens_at;

    if (Number.isFinite(revealAtMs) && nowMs >= revealAtMs) {
      await revealAndSettleMarket(mid);
      notes.push({ marketId: mid, reason: "reveal_timeout" });
      continue;
    }

    if (marketType === "city_grid") {
      const crossed = await driverCrossedCell(service, {
        row,
        sessionId,
      });
      void opensAtStr;
      if (crossed) {
        await revealAndSettleMarket(mid);
        notes.push({ marketId: mid, reason: "cell_crossed" });
      }
      continue;
    }

    if (marketType === "next_turn") {
      const passed = await driverPassedPin(service, {
        row,
        sessionId,
      });
      if (passed) {
        await revealAndSettleMarket(mid);
        notes.push({ marketId: mid, reason: "pin_passed" });
      }
      continue;
    }

    if (isEngineMarketType(marketType)) {
      const settle = await shouldSettleEngineMarket(service, {
        marketId: mid,
        marketType,
        locksAt: locksAtStr,
        liveSessionId: sessionId,
        roomId,
      });
      if (settle) {
        await revealAndSettleMarket(mid);
        notes.push({ marketId: mid, reason: `engine_${marketType}` });
      }
    }
  }

  return notes;
}

async function driverCrossedCell(
  service: Awaited<ReturnType<typeof createServiceClient>>,
  args: {
    row: unknown;
    sessionId: string | null;
  },
): Promise<boolean> {
  const gridSpec = (args.row as { city_grid_spec: CityGridSpecCompact | null })
    .city_grid_spec;
  if (!gridSpec || !args.sessionId) return false;

  /**
   * The market's subtitle JSON carries the start cell coordinates (row/col)
   * captured at open time — see `openCityGridMarketForRoom`. We compare
   * against the driver's latest cell to decide if they have crossed out.
   */
  const subtitleStr = (args.row as { subtitle: string | null }).subtitle;
  let startRow: number | null = null;
  let startCol: number | null = null;
  try {
    const meta = JSON.parse(subtitleStr ?? "{}") as {
      startRow?: number;
      startCol?: number;
    };
    if (typeof meta.startRow === "number") startRow = meta.startRow;
    if (typeof meta.startCol === "number") startCol = meta.startCol;
  } catch {
    // ignore parse errors — without a start cell we cannot decide a crossing.
  }
  if (startRow == null || startCol == null) return false;

  const { data: latest } = await service
    .from("live_route_snapshots")
    .select("normalized_lat,normalized_lng,raw_lat,raw_lng")
    .eq("live_session_id", args.sessionId)
    .order("recorded_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!latest) return false;
  const g = latest as {
    normalized_lat: number | null;
    normalized_lng: number | null;
    raw_lat: number;
    raw_lng: number;
  };
  const currentCell = cellIdForPosition(
    gridSpec,
    g.normalized_lat ?? g.raw_lat,
    g.normalized_lng ?? g.raw_lng,
  );
  if (!currentCell) return false;
  const startCell = `grid:r${startRow}:c${startCol}`;
  return currentCell !== startCell;
}

async function driverPassedPin(
  service: Awaited<ReturnType<typeof createServiceClient>>,
  args: { row: unknown; sessionId: string | null },
): Promise<boolean> {
  if (!args.sessionId) return false;
  const turnLat = (args.row as { turn_point_lat: number | null }).turn_point_lat;
  const turnLng = (args.row as { turn_point_lng: number | null }).turn_point_lng;
  if (turnLat == null || turnLng == null) return false;

  const { data: latest } = await service
    .from("live_route_snapshots")
    .select("normalized_lat,normalized_lng,raw_lat,raw_lng")
    .eq("live_session_id", args.sessionId)
    .order("recorded_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!latest) return false;
  const g = latest as {
    normalized_lat: number | null;
    normalized_lng: number | null;
    raw_lat: number;
    raw_lng: number;
  };
  const lat = g.normalized_lat ?? g.raw_lat;
  const lng = g.normalized_lng ?? g.raw_lng;
  const dLat = (lat - turnLat) * 111_320;
  const dLng =
    (lng - turnLng) * 111_320 * Math.cos((turnLat * Math.PI) / 180);
  const dist = Math.hypot(dLat, dLng);
  // Within ~15 m of the pin is "passed" for settlement purposes.
  return dist <= 15;
}
