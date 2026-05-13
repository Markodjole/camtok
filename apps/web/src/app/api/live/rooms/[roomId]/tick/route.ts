import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { openCityGridMarketForRoom } from "@/actions/live-city-grid-market";
import {
  openEngineMarketForRoom,
  shouldSettleEngineMarket,
  type ZoneExitPhase,
} from "@/actions/live-engine-market";
import { openNextTurnMarketForRoom } from "@/actions/live-next-turn-market";
import { lockMarket, revealAndSettleMarket } from "@/actions/live-settlement";
import { isEngineMarketType } from "@/lib/live/betting/engineMarketOptions";
import {
  NEXT_TURN_PIN_MIN_M,
  NEXT_TURN_PIN_MAX_M,
  NEXT_ZONE_TRIGGER_M,
  ZONE_EXIT_CENTER_TRIGGER_M,
  ZONE_EXIT_OUTER_TRIGGER_MIN_M,
} from "@/lib/live/betting/betWindowConstants";
import {
  cellIdForPosition,
  gridCellCenter,
  parseGridOptionId,
  type CityGridSpecCompact,
} from "@/lib/live/grid/cityGrid500";
import { getOrBuildGridSpecForRoom } from "@/lib/live/grid/gridSpecForRoom";
import { metersBetween } from "@/lib/live/routing/geometry";
import { computeDriverRouteInstruction } from "@/lib/live/routing/computeDriverRouteInstruction";

/**
 * Bet trigger rules — the single source of truth for when each market opens:
 *
 *  next_zone       fires ONCE per cell when driver ≤ 100 m from cell center.
 *  zone_exit_time  fires ≤ 3× per cell:
 *                    "entry"      — on zone entry (driver inside cell)
 *                    "center_70m" — when driver ≤ 70 m from center
 *                    "exit_outer" — when driver ≥ 100 m from center after being ≤ 70 m
 *  next_turn       fires once per pin when driver is 90–150 m from pin.
 *
 *  Queue: if a trigger fires while a bet is on screen the trigger is stored in
 *  live_rooms.queued_triggers and opened the moment the screen clears.
 *  Queue entries expire after 30 s (stale if market ran its full 7 s cycle twice).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ─── Queue types ──────────────────────────────────────────────────────────────

type QueuedNextTurn = {
  type: "next_turn";
  pinKey: string;
  pinId: number;
  pinLat: number;
  pinLng: number;
  queuedAt: number;
};
type QueuedNextZone = {
  type: "next_zone";
  cellKey: string;
  queuedAt: number;
};
type QueuedZoneExit = {
  type: "zone_exit_time";
  phase: ZoneExitPhase;
  cellKey: string;
  capturedZone: string | null;
  queuedAt: number;
};
type QueuedTrigger = QueuedNextTurn | QueuedNextZone | QueuedZoneExit;

const QUEUE_EXPIRY_MS = 30_000;

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ roomId: string }> },
) {
  const { roomId } = await ctx.params;
  const service = await createServiceClient();

  const settleNotes = await sweepPendingSettlements(service, roomId);

  // region_label lives on character_live_sessions, not live_rooms.
  // Select only columns that actually exist on live_rooms.
  const { data: room, error: roomErr } = await service
    .from("live_rooms")
    .select("id, phase, current_market_id, live_session_id")
    .eq("id", roomId)
    .maybeSingle();
  if (roomErr) {
    console.error("[tick] room select error", roomErr);
  }
  if (!room) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Fetch region_label from the live session (needed for zone_exit_time capturedZone).
  const sessionId = (room as { live_session_id: string }).live_session_id;
  const { data: sessionRow } = await service
    .from("character_live_sessions")
    .select("region_label")
    .eq("id", sessionId)
    .maybeSingle();
  const capturedZone = (sessionRow as { region_label: string | null } | null)?.region_label ?? null;

  const phase = (room as { phase: string }).phase;
  const marketId = (room as { current_market_id: string | null }).current_market_id;

  // ─── 1. Lock expired market ────────────────────────────────────────────────
  if (phase === "market_open" && marketId) {
    const { data: market } = await service
      .from("live_betting_markets")
      .select("id, status, locks_at, market_type")
      .eq("id", marketId)
      .maybeSingle();
    if (market) {
      const status = (market as { status: string }).status;
      const mType = (market as { market_type: string }).market_type;
      const locksAtMs = new Date((market as { locks_at: string }).locks_at).getTime();
      const isActiveType =
        mType === "next_turn" || mType === "city_grid" || mType === "zone_exit_time";
      const shouldLockNow = status === "open" && (Date.now() >= locksAtMs || !isActiveType);
      if (shouldLockNow) {
        const lockResult = await lockMarket(marketId);
        if ("commitHash" in lockResult) {
          await service
            .from("live_rooms")
            .update({
              phase: "waiting_for_next_market",
              current_market_id: null,
              last_event_at: new Date().toISOString(),
            })
            .eq("id", roomId)
            .eq("current_market_id", marketId);
        }
      }
    }
  }

  // ─── 2. Re-read phase + queue ──────────────────────────────────────────────
  // queued_triggers is a recently added column; guard against schema-cache lag
  // by reading phase (safe) and queue (may fail) in two separate tolerant reads.
  const { data: room2 } = await service
    .from("live_rooms")
    .select("phase")
    .eq("id", roomId)
    .maybeSingle();
  const phaseNow = (room2 as { phase: string } | null)?.phase ?? phase;

  let currentQueue: QueuedTrigger[] = [];
  try {
    const { data: queueRow } = await service
      .from("live_rooms")
      .select("queued_triggers")
      .eq("id", roomId)
      .maybeSingle();
    const rawQueue = (queueRow as { queued_triggers: unknown } | null)?.queued_triggers;
    if (Array.isArray(rawQueue)) currentQueue = rawQueue as QueuedTrigger[];
  } catch {
    // queued_triggers column not yet visible via PostgREST — proceed with empty queue
  }

  // ─── 3. Detect triggers and update queue ──────────────────────────────────
  // sessionId and capturedZone are resolved above from room + sessionRow.
  const freshTriggers = await detectEligibleTriggers(service, roomId, sessionId, capturedZone);

  if (phaseNow === "market_open") {
    // Cannot open yet; queue any triggers not already queued or fired.
    const updatedQueue = buildUpdatedQueue(currentQueue, freshTriggers);
    if (updatedQueue.length !== currentQueue.length) {
      await service
        .from("live_rooms")
        .update({ queued_triggers: updatedQueue })
        .eq("id", roomId);
    }
    return NextResponse.json({ action: "market_open_queued", queued: updatedQueue.length, settled: settleNotes });
  }

  if (phaseNow === "waiting_for_next_market") {
    const opened = await openFromQueueOrTriggers(service, roomId, currentQueue, freshTriggers);
    return NextResponse.json({
      action: opened.action,
      ...(opened.detail ?? {}),
      settled: settleNotes,
    });
  }

  if (phaseNow === "market_locked" && marketId) {
    const r = await revealAndSettleMarket(marketId);
    // If settle failed (market not locked yet or already settled), unstick the room.
    if ("error" in r) {
      await service
        .from("live_rooms")
        .update({ phase: "waiting_for_next_market", current_market_id: null, last_event_at: new Date().toISOString() })
        .eq("id", roomId);
    }
    return NextResponse.json({ action: "legacy_locked_settle", ...r, settled: settleNotes });
  }

  return NextResponse.json({ action: "noop", phase: phaseNow, settled: settleNotes });
}

// ─── Queue helpers ────────────────────────────────────────────────────────────

function triggerKey(t: QueuedTrigger): string {
  if (t.type === "next_turn") return `next_turn:${t.pinKey}`;
  if (t.type === "next_zone") return `next_zone:${t.cellKey}`;
  return `zone_exit_time:${t.cellKey}:${t.phase}`;
}

function freshTriggerKey(t: { type: string; pinKey?: string; cellKey?: string; phase?: string }): string {
  if (t.type === "next_turn") return `next_turn:${t.pinKey}`;
  if (t.type === "next_zone") return `next_zone:${t.cellKey}`;
  return `zone_exit_time:${t.cellKey}:${t.phase}`;
}

function buildUpdatedQueue(
  existing: QueuedTrigger[],
  fresh: FreshTrigger[],
): QueuedTrigger[] {
  const now = Date.now();
  // Drop expired entries.
  const alive = existing.filter((t) => now - t.queuedAt < QUEUE_EXPIRY_MS);
  const existingKeys = new Set(alive.map(triggerKey));

  for (const ft of fresh) {
    const key = freshTriggerKey(ft);
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);
    if (ft.type === "next_turn") {
      alive.push({ type: "next_turn", pinKey: ft.pinKey!, pinId: ft.pinId!, pinLat: ft.pinLat!, pinLng: ft.pinLng!, queuedAt: now });
    } else if (ft.type === "next_zone") {
      alive.push({ type: "next_zone", cellKey: ft.cellKey!, queuedAt: now });
    } else {
      alive.push({ type: "zone_exit_time", phase: ft.phase! as ZoneExitPhase, cellKey: ft.cellKey!, capturedZone: ft.capturedZone ?? null, queuedAt: now });
    }
  }
  return alive;
}

// ─── Open from queue or fresh triggers ───────────────────────────────────────

async function openFromQueueOrTriggers(
  service: Awaited<ReturnType<typeof createServiceClient>>,
  roomId: string,
  queue: QueuedTrigger[],
  fresh: FreshTrigger[],
): Promise<{ action: string; detail?: Record<string, unknown> }> {
  const now = Date.now();

  // Re-read the phase just before opening to guard against concurrent ticks
  // that may have already opened a market in the milliseconds since this tick
  // read "waiting_for_next_market".
  const { data: latestRoom } = await service
    .from("live_rooms")
    .select("phase")
    .eq("id", roomId)
    .maybeSingle();
  if ((latestRoom as { phase: string } | null)?.phase !== "waiting_for_next_market") {
    return { action: "already_opening", detail: { phase: (latestRoom as { phase: string } | null)?.phase } };
  }

  // Clear the queue on the room as we're about to consume it.
  await service
    .from("live_rooms")
    .update({ queued_triggers: [] })
    .eq("id", roomId);

  const openerErrors: Array<{ trigger: string; error: string }> = [];

  // Priority order: next_turn > next_zone > zone_exit_time phases.
  const prioritySorted = [...queue]
    .filter((t) => now - t.queuedAt < QUEUE_EXPIRY_MS)
    .sort((a, b) => triggerPriority(a) - triggerPriority(b));

  for (const trigger of prioritySorted) {
    const res = await openQueuedTrigger(trigger, roomId);
    if ("marketId" in res && res.marketId) {
      return {
        action: `opened_${trigger.type}_from_queue`,
        detail: { marketId: res.marketId, trigger },
      };
    }
    openerErrors.push({ trigger: triggerKey(trigger), error: (res as { error?: string }).error ?? "unknown" });
  }

  // No queue hit — try fresh triggers in priority order.
  const freshSorted = [...fresh].sort((a, b) => freshPriority(a) - freshPriority(b));
  for (const ft of freshSorted) {
    const res = await openFreshTrigger(ft, roomId);
    if ("marketId" in res && res.marketId) {
      return {
        action: `opened_${ft.type}`,
        detail: { marketId: res.marketId },
      };
    }
    openerErrors.push({ trigger: freshTriggerKey(ft), error: (res as { error?: string }).error ?? "unknown" });
  }

  // Log errors so they appear in Vercel function logs.
  if (openerErrors.length) {
    console.warn("[tick] all openers failed", JSON.stringify(openerErrors));
  }

  return {
    action: "no_eligible_bet",
    detail: { queueSize: queue.length, freshCount: fresh.length, openerErrors },
  };
}

function triggerPriority(t: QueuedTrigger): number {
  if (t.type === "next_turn") return 1;
  if (t.type === "next_zone") return 2;
  // zone_exit_time phases: entry first, then center, then outer
  const phases: ZoneExitPhase[] = ["entry", "center_70m", "exit_outer"];
  return 3 + phases.indexOf(t.phase as ZoneExitPhase);
}

function freshPriority(t: FreshTrigger): number {
  if (t.type === "next_turn") return 1;
  if (t.type === "next_zone") return 2;
  const phases: ZoneExitPhase[] = ["entry", "center_70m", "exit_outer"];
  return 3 + phases.indexOf(t.phase as ZoneExitPhase);
}

async function openQueuedTrigger(trigger: QueuedTrigger, roomId: string) {
  if (trigger.type === "next_turn") {
    // Pass the queued pin so the opener can skip the lower-bound distance
    // check — the window was already validated when the trigger was queued.
    return openNextTurnMarketForRoom(roomId, { queuedPinId: trigger.pinId });
  }
  if (trigger.type === "next_zone") return openCityGridMarketForRoom(roomId);
  return openEngineMarketForRoom(roomId, { phase: trigger.phase });
}

async function openFreshTrigger(ft: FreshTrigger, roomId: string) {
  if (ft.type === "next_turn") return openNextTurnMarketForRoom(roomId);
  if (ft.type === "next_zone") return openCityGridMarketForRoom(roomId);
  return openEngineMarketForRoom(roomId, { phase: ft.phase as ZoneExitPhase });
}

// ─── Trigger detection ────────────────────────────────────────────────────────

type FreshTrigger = {
  type: "next_turn" | "next_zone" | "zone_exit_time";
  pinKey?: string;
  pinId?: number;
  pinLat?: number;
  pinLng?: number;
  cellKey?: string;
  phase?: string;
  capturedZone?: string | null;
};

async function detectEligibleTriggers(
  service: Awaited<ReturnType<typeof createServiceClient>>,
  roomId: string,
  sessionId: string,
  capturedZone: string | null,
): Promise<FreshTrigger[]> {
  const eligible: FreshTrigger[] = [];

  // ── GPS ────────────────────────────────────────────────────────────────────
  const { data: gpsRow } = await service
    .from("live_route_snapshots")
    .select("normalized_lat,normalized_lng,raw_lat,raw_lng")
    .eq("live_session_id", sessionId)
    .order("recorded_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!gpsRow) return eligible;
  const g = gpsRow as { normalized_lat: number | null; normalized_lng: number | null; raw_lat: number; raw_lng: number };
  const lat = g.normalized_lat ?? g.raw_lat;
  const lng = g.normalized_lng ?? g.raw_lng;

  // ── Grid context ───────────────────────────────────────────────────────────
  const specRes = await getOrBuildGridSpecForRoom(service, roomId, sessionId);
  if (specRes.ok) {
    const spec = specRes.spec;
    const cellId = cellIdForPosition(spec, lat, lng);
    if (cellId) {
      const parsed = parseGridOptionId(cellId);
      if (parsed) {
        const center = gridCellCenter(spec, parsed.row, parsed.col);
        const distM = metersBetween({ lat, lng }, center);
        const cellKey = `cell:r${parsed.row}:c${parsed.col}`;

        // ── next_zone trigger ──────────────────────────────────────────────
        if (distM <= NEXT_ZONE_TRIGGER_M) {
          const fired = await hasFiredCityGrid(service, roomId, cellKey);
          if (!fired) {
            eligible.push({ type: "next_zone", cellKey });
          }
        }

        // ── zone_exit_time trigger phases ──────────────────────────────────
        const firedPhases = await loadFiredPhasesFromDB(service, sessionId, cellKey);

        if (!firedPhases.has("entry")) {
          eligible.push({ type: "zone_exit_time", phase: "entry", cellKey, capturedZone });
        }
        if (!firedPhases.has("center_70m") && distM <= ZONE_EXIT_CENTER_TRIGGER_M) {
          eligible.push({ type: "zone_exit_time", phase: "center_70m", cellKey, capturedZone });
        }
        if (
          !firedPhases.has("exit_outer") &&
          firedPhases.has("center_70m") &&
          distM >= ZONE_EXIT_OUTER_TRIGGER_MIN_M
        ) {
          eligible.push({ type: "zone_exit_time", phase: "exit_outer", cellKey, capturedZone });
        }
      }
    }
  }

  // ── next_turn trigger ──────────────────────────────────────────────────────
  try {
    const drv = await computeDriverRouteInstruction(roomId);
    const pin = drv.instruction?.pins?.[0] ?? null;
    if (pin && Number.isFinite(pin.distanceMeters)) {
      const d = pin.distanceMeters;
      if (d >= NEXT_TURN_PIN_MIN_M && d <= NEXT_TURN_PIN_MAX_M) {
        const pinKey = `pin:${pin.id}`;
        const fired = await hasFiredNextTurn(service, roomId, pinKey);
        if (!fired) {
          eligible.push({ type: "next_turn", pinKey, pinId: pin.id, pinLat: pin.lat, pinLng: pin.lng });
        }
      }
    }
  } catch {
    // routing errors are non-fatal
  }

  return eligible;
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

async function hasFiredCityGrid(
  service: Awaited<ReturnType<typeof createServiceClient>>,
  roomId: string,
  cellKey: string,
): Promise<boolean> {
  const { data } = await service
    .from("live_betting_markets")
    .select("subtitle")
    .eq("room_id", roomId)
    .eq("market_type", "city_grid")
    .order("opens_at", { ascending: false })
    .limit(30);
  return (data ?? []).some((row) => {
    try {
      const meta = JSON.parse((row as { subtitle: string | null }).subtitle ?? "{}") as { cellKey?: string };
      return meta.cellKey === cellKey;
    } catch {
      return false;
    }
  });
}

async function hasFiredNextTurn(
  service: Awaited<ReturnType<typeof createServiceClient>>,
  roomId: string,
  pinKey: string,
): Promise<boolean> {
  const { data } = await service
    .from("live_betting_markets")
    .select("subtitle")
    .eq("room_id", roomId)
    .eq("market_type", "next_turn")
    .order("opens_at", { ascending: false })
    .limit(20);
  return (data ?? []).some((row) => {
    try {
      const meta = JSON.parse((row as { subtitle: string | null }).subtitle ?? "{}") as { pinKey?: string };
      return meta.pinKey === pinKey;
    } catch {
      return false;
    }
  });
}

async function loadFiredPhasesFromDB(
  service: Awaited<ReturnType<typeof createServiceClient>>,
  liveSessionId: string,
  cellKey: string,
): Promise<Set<ZoneExitPhase>> {
  const { data } = await service
    .from("live_betting_markets")
    .select("subtitle")
    .eq("live_session_id", liveSessionId)
    .eq("market_type", "zone_exit_time");
  const fired = new Set<ZoneExitPhase>();
  for (const row of data ?? []) {
    try {
      const meta = JSON.parse((row as { subtitle: string | null }).subtitle ?? "{}") as { cellKey?: string; triggerPhase?: string };
      if (meta.cellKey === cellKey && meta.triggerPhase) {
        fired.add(meta.triggerPhase as ZoneExitPhase);
      }
    } catch {
      // ignore
    }
  }
  return fired;
}

// ─── Settlement sweep ─────────────────────────────────────────────────────────

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
    const sessionId = (row as { live_session_id: string | null }).live_session_id;

    if (Number.isFinite(revealAtMs) && nowMs >= revealAtMs) {
      await revealAndSettleMarket(mid);
      notes.push({ marketId: mid, reason: "reveal_timeout" });
      continue;
    }

    if (marketType === "city_grid") {
      const crossed = await driverCrossedCell(service, { row, sessionId });
      if (crossed) {
        await revealAndSettleMarket(mid);
        notes.push({ marketId: mid, reason: "cell_crossed" });
      }
      continue;
    }

    if (marketType === "next_turn") {
      const passed = await driverPassedPin(service, { row, sessionId });
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
  args: { row: unknown; sessionId: string | null },
): Promise<boolean> {
  const gridSpec = (args.row as { city_grid_spec: CityGridSpecCompact | null }).city_grid_spec;
  if (!gridSpec || !args.sessionId) return false;

  const subtitleStr = (args.row as { subtitle: string | null }).subtitle;
  let startRow: number | null = null;
  let startCol: number | null = null;
  try {
    const meta = JSON.parse(subtitleStr ?? "{}") as { startRow?: number; startCol?: number };
    if (typeof meta.startRow === "number") startRow = meta.startRow;
    if (typeof meta.startCol === "number") startCol = meta.startCol;
  } catch {
    // ignore
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
  const g = latest as { normalized_lat: number | null; normalized_lng: number | null; raw_lat: number; raw_lng: number };
  const currentCell = cellIdForPosition(gridSpec, g.normalized_lat ?? g.raw_lat, g.normalized_lng ?? g.raw_lng);
  if (!currentCell) return false;
  return currentCell !== `grid:r${startRow}:c${startCol}`;
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
  const g = latest as { normalized_lat: number | null; normalized_lng: number | null; raw_lat: number; raw_lng: number };
  const lat = g.normalized_lat ?? g.raw_lat;
  const lng = g.normalized_lng ?? g.raw_lng;
  const dLat = (lat - turnLat) * 111_320;
  const dLng = (lng - turnLng) * 111_320 * Math.cos((turnLat * Math.PI) / 180);
  return Math.hypot(dLat, dLng) <= 15;
}
