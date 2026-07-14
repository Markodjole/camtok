/**
 * Core live-room tick logic.
 *
 * Extracted from the HTTP route so it can be called by:
 *   - /api/live/rooms/[roomId]/tick  (kept for local-dev / manual triggers)
 *   - /api/cron/live-tick            (server-side 1 Hz worker — primary path)
 *
 * The caller is responsible for the CAS lock (acquireTickLock /
 * releaseTickLock) so this function never runs concurrently for the same room.
 */

import { createServiceClient } from "@/lib/supabase/server";
import { openCityGridMarketForRoom } from "@/actions/live-city-grid-market";
import {
  openEngineMarketForRoom,
  shouldSettleEngineMarket,
  type ZoneExitPhase,
} from "@/actions/live-engine-market";
import { openNextStepMarketForRoom } from "@/actions/live-next-step-market";
import { openNextTurnMarketForRoom } from "@/actions/live-next-turn-market";
import { openStraightStreakMarketForRoom } from "@/actions/live-straight-streak-market";
import { openOvertake30sMarketForRoom } from "@/actions/live-overtake-market";
import { lockAndSettleMarket, lockMarket, revealAndSettleMarket, cancelAndRefundMarket } from "@/actions/live-settlement";
import { isEngineMarketType } from "@/lib/live/betting/engineMarketOptions";
import { shouldSettleOvertakeMarket } from "@/lib/live/betting/shouldSettleOvertakeMarket";
import {
  BET_OPEN_WINDOW_MS,
  BET_OPEN_WINDOW_IDLE_MS,
  NEXT_STEP_FILLER_MAX_ROAD_M,
  NEXT_STEP_FORWARD_PIN_BUCKET_M,
  NEXT_STEP_FORWARD_PIN_ROAD_M,
  NEXT_STEP_MAX_ROAD_M,
  NEXT_STEP_MIN_ROAD_M,
  NEXT_STEP_ON_ROUTE_M,
  NEXT_TURN_PIN_MIN_M,
  NEXT_TURN_PIN_MAX_M,
  NEXT_ZONE_TRIGGER_M,
  STRAIGHT_STREAK_MIN_LENGTH,
  ZONE_EXIT_CENTER_TRIGGER_M,
  ZONE_EXIT_OUTER_TRIGGER_MIN_M,
} from "@/lib/live/betting/betWindowConstants";
import {
  betSchedulePriority,
  evaluateBetOpen,
  triggerCellDwellMs,
  type BetOpenContext,
  type BetTriggerType,
} from "@/lib/live/betting/betScheduleConfig";
import {
  buildBetOpenContext,
  loadBetSchedulerState,
  nextCellDwellState,
  persistBetSchedulerState,
  recordBetOpened,
  type BetSchedulerState,
} from "@/lib/live/betting/betSchedulerState";
import type { OsrmStep } from "@/lib/live/routing/osrmSteps";
import {
  evaluateResolutionConditions,
  type MarketSweepRow,
} from "@/lib/live/market-resolvers/resolutionEvaluator";
import {
  cellIdForPosition,
  gridCellCenter,
  parseGridOptionId,
  type CityGridSpecCompact,
} from "@/lib/live/grid/cityGrid500";
import { getOrBuildGridSpecForRoom } from "@/lib/live/grid/gridSpecForRoom";
import {
  bearingDegrees,
  cumulativeMetersAt,
  type LatLng,
  metersBetween,
  projectOntoPolyline,
  projectPoint,
  roadDistanceAlongPolyline,
  slicePolylineByDistance,
} from "@/lib/live/routing/geometry";
import {
  fetchOsrmDrivingRouteWithSteps,
  isBookendManeuver,
} from "@/lib/live/routing/osrmSteps";
import { computeDriverRouteInstruction } from "@/lib/live/routing/computeDriverRouteInstruction";
import { analyzeStreakAhead } from "@/lib/live/routing/straightStreakAnalyzer";
import {
  NEXT_STEP_BETS_ENABLED,
  NEXT_TURN_BETS_ENABLED,
  STRAIGHT_STREAK_BETS_ENABLED,
} from "@/lib/live/featureFlags";

// ─── Sweep diagnostic log ─────────────────────────────────────────────────────
//
// Ring buffer (last LOG_RING_SIZE entries) per marketId. Written by every sweep
// pass so you can always call GET /api/live/market-debug/[id] and see exactly
// why a market did or didn't settle on recent ticks.
//
// In-process only: survives between ticks on a persistent Node process (the
// normal deployment). Lost on cold start; the debug endpoint falls back to a
// live re-analysis in that case.

const LOG_RING_SIZE = 30;

export type SweepLogEntry = {
  ts: number;       // Date.now() when this entry was written
  marketType: string;
  check: string;    // what condition was evaluated
  result: boolean;  // outcome of the check
  detail: string;   // human-readable context
};

const MARKET_SWEEP_LOG = new Map<string, SweepLogEntry[]>();

function appendSweepLog(
  marketId: string,
  entry: Omit<SweepLogEntry, "ts">,
): void {
  const list = MARKET_SWEEP_LOG.get(marketId) ?? [];
  list.push({ ts: Date.now(), ...entry });
  if (list.length > LOG_RING_SIZE) list.splice(0, list.length - LOG_RING_SIZE);
  MARKET_SWEEP_LOG.set(marketId, list);
}

/** Read the sweep log for one market (newest-first). */
export function getMarketSweepLog(marketId: string): SweepLogEntry[] {
  return [...(MARKET_SWEEP_LOG.get(marketId) ?? [])].reverse();
}

// ─── Lock constants ───────────────────────────────────────────────────────────

// 15 s gives enough headroom for the worst-case tick (OSRM + Google + TfL +
// Overpass in one pass).  The old 5 s TTL was shorter than that hot path,
// allowing a second worker to grab the lock mid-tick and double-open markets.
export const TICK_LOCK_TTL_MS = 15_000;

/** Queue entries older than this are considered stale and discarded. */
const QUEUE_EXPIRY_MS = 30_000;

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
type QueuedStraightStreak = {
  type: "straight_streak";
  /** De-dupe key — "streak:<firstNodeId>" of the straight sequence. */
  streakKey: string;
  queuedAt: number;
  /**
   * Pre-computed streak analysis captured at detection time.  Passed to the
   * opener so it never needs to re-run computeDriverRouteInstruction — which
   * would hit a different ROOM_STATE snapshot (or a cold serverless worker)
   * and return different pins, causing opener re-validation to fail.
   */
  expectedStreak?: number;
  crossroads?: import("@/lib/live/routing/straightStreakAnalyzer").CrossroadBearing[];
};
type QueuedNextStep = {
  type: "next_step";
  /** De-dupe key — "step:{lat4}:{lng4}" of the OSRM maneuver point. */
  stepKey: string;
  stepLat: number;
  stepLng: number;
  maneuverType: string;
  maneuverModifier?: string;
  stepName: string;
  queuedAt: number;
};
export type QueuedTrigger =
  | QueuedNextTurn
  | QueuedNextZone
  | QueuedZoneExit
  | QueuedStraightStreak
  | QueuedNextStep;

// ─── Public API ───────────────────────────────────────────────────────────────

export type TickResult = Record<string, unknown>;

/**
 * Acquire a CAS tick lock for a room.
 * Returns true if the lock was acquired, false if another tick owns it.
 */
export async function acquireTickLock(
  service: Awaited<ReturnType<typeof createServiceClient>>,
  roomId: string,
): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const expiryIso = new Date(Date.now() + TICK_LOCK_TTL_MS).toISOString();

  const { data } = await service
    .from("live_rooms")
    .update({ tick_locked_until: expiryIso })
    .eq("id", roomId)
    .or(`tick_locked_until.is.null,tick_locked_until.lt.${nowIso}`)
    .select("id")
    .maybeSingle();

  return data != null;
}

/**
 * Release the CAS tick lock. Fire-and-forget safe (errors are swallowed).
 */
export async function releaseTickLock(
  service: Awaited<ReturnType<typeof createServiceClient>>,
  roomId: string,
): Promise<void> {
  await service
    .from("live_rooms")
    .update({ tick_locked_until: null })
    .eq("id", roomId);
}

/**
 * Run one tick for a room.  Caller must hold the tick lock before calling.
 */
export async function runRoomTick(
  roomId: string,
  service: Awaited<ReturnType<typeof createServiceClient>>,
): Promise<TickResult> {
  const settleNotes = await sweepPendingSettlements(service, roomId);

  // region_label lives on character_live_sessions, not live_rooms.
  const { data: room, error: roomErr } = await service
    .from("live_rooms")
    .select("id, phase, current_market_id, current_step_market_id, live_session_id")
    .eq("id", roomId)
    .maybeSingle();
  if (roomErr) console.error("[tick] room select error", roomErr);
  if (!room) return { error: "not_found" };

  const sessionId = (room as { live_session_id: string }).live_session_id;
  const { data: sessionRow } = await service
    .from("character_live_sessions")
    .select("region_label")
    .eq("id", sessionId)
    .maybeSingle();
  const capturedZone =
    (sessionRow as { region_label: string | null } | null)?.region_label ?? null;

  const phase = (room as { phase: string }).phase;
  const marketId = (room as { current_market_id: string | null }).current_market_id;
  const stepMarketId = (room as { current_step_market_id: string | null }).current_step_market_id;

  // ─── 1. Lock (and optionally settle) expired market ─────────────────────
  //
  // When the bet window (locks_at) expires:
  //
  //   • next_turn / city_grid / other non-engine types:
  //       `lockAndSettleMarket` — lock bets AND resolve + pay in one tick.
  //       Room pointer cleared by payout; viewers never see a gap.
  //
  //   • zone_exit_time (engine-driven):
  //       `lockMarket` ONLY — freeze bets but defer settlement to
  //       `sweepPendingSettlements` which calls `shouldSettleEngineMarket`
  //       each tick. Settling here would resolve as exit_over because the
  //       driver is almost always still inside the start cell at 8 s.
  //       Settlement fires when the driver actually leaves OR estimatedSec
  //       elapses, which can be 30–180 s after open.
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
      // Any market type that has a meaningful locks_at window — lock only when
      // the timer expires rather than immediately.  Derived from the schedule
      // so new bet types are covered automatically once they appear there.
      const isActiveType = isEngineMarketType(mType) || mType === "next_turn" || mType === "city_grid";
      const shouldLockNow = status === "open" && (Date.now() >= locksAtMs || !isActiveType);
      if (shouldLockNow) {
        if (isEngineMarketType(mType)) {
          // Lock bets only — settlement deferred to sweep (shouldSettleEngineMarket).
          console.log(
            `[tick] locking engine market ${marketId} (${mType}) — settlement deferred`,
            { roomId, locksAt: (market as { locks_at: string }).locks_at },
          );
          await lockMarket(marketId);
          // Room stays in market_locked phase with current_market_id intact
          // so the client keeps showing the ZoneExitCountdownWidget.
        } else {
          // Lock → resolve winner → pay — all in one tick.
          await lockAndSettleMarket(marketId);
        }
      }
    }
  }

  // ─── 1b. Lock expired step-slot market (independent of main slot) ────────
  if (stepMarketId) {
    const { data: stepMarket } = await service
      .from("live_betting_markets")
      .select("id, status, locks_at, market_type")
      .eq("id", stepMarketId)
      .maybeSingle();
    if (stepMarket) {
      const sStatus = (stepMarket as { status: string }).status;
      const sLocksAtMs = new Date((stepMarket as { locks_at: string }).locks_at).getTime();
      if (sStatus === "open" && Date.now() >= sLocksAtMs) {
        console.log(
          `[tick] locking step market ${stepMarketId} (next_step) — settlement deferred to sweep`,
          { roomId },
        );
        // lockMarket now skips the room-phase update for next_step — safe to call here.
        await lockMarket(stepMarketId);
      }
    }
  }

  // ─── 2. Re-read phase + queue ────────────────────────────────────────────
  const { data: room2 } = await service
    .from("live_rooms")
    .select("phase, current_market_id, current_step_market_id")
    .eq("id", roomId)
    .maybeSingle();
  const phaseNow = (room2 as { phase: string } | null)?.phase ?? phase;
  const marketIdNow =
    (room2 as { current_market_id: string | null } | null)?.current_market_id ?? marketId;
  const stepMarketIdNow =
    (room2 as { current_step_market_id: string | null } | null)?.current_step_market_id ??
    stepMarketId;

  let currentQueue: QueuedTrigger[] = [];
  try {
    const { data: queueRow } = await service
      .from("live_rooms")
      .select("queued_triggers")
      .eq("id", roomId)
      .maybeSingle();
    const raw = (queueRow as { queued_triggers: unknown } | null)?.queued_triggers;
    if (Array.isArray(raw)) currentQueue = raw as QueuedTrigger[];
  } catch {
    // queued_triggers not visible yet — proceed with empty queue
  }

  // ─── 3. Detect fresh triggers ────────────────────────────────────────────
  // Load all fired-key data in one batch query (replaces 5 per-type queries).
  const firedKeys = await loadFiredKeysSnapshot(service, sessionId);
  let scheduler = await loadBetSchedulerState(service, roomId);
  const detectResult = await detectEligibleTriggers(
    service,
    roomId,
    sessionId,
    capturedZone,
    firedKeys,
    scheduler,
  );
  if (detectResult.scheduler !== scheduler) {
    await persistBetSchedulerState(service, roomId, detectResult.scheduler);
  }
  scheduler = detectResult.scheduler;
  const { eligible: rawFreshTriggers, routeCtx } = detectResult;

  const mainMarketType = await resolveMainMarketType(service, marketIdNow);
  const stepMarketOpen = await resolveStepMarketOpen(service, stepMarketIdNow);
  const openCtx = buildBetOpenContext(
    scheduler,
    {
      phase: phaseNow,
      current_market_id: marketIdNow,
      current_step_market_id: stepMarketIdNow,
    },
    mainMarketType,
    stepMarketOpen,
  );

  if (phaseNow === "market_open") {
    const updatedQueue = buildUpdatedQueue(currentQueue, rawFreshTriggers);
    if (updatedQueue.length !== currentQueue.length) {
      await service
        .from("live_rooms")
        .update({ queued_triggers: updatedQueue })
        .eq("id", roomId);
    }

    if (
      !stepMarketIdNow &&
      NEXT_STEP_BETS_ENABLED &&
      evaluateBetOpen("next_step", openCtx).allowed
    ) {
      const stepTrigger = rawFreshTriggers.find((t) => t.type === "next_step");
      if (stepTrigger) {
        const res = await openNextStepMarketForRoom(roomId, {
          windowMs: BET_OPEN_WINDOW_IDLE_MS,
          stepKey: stepTrigger.stepKey,
          stepLat: stepTrigger.stepLat,
          stepLng: stepTrigger.stepLng,
          maneuverType: stepTrigger.maneuverType,
          maneuverModifier: stepTrigger.maneuverModifier,
          stepName: stepTrigger.maneuverType === "camera" ? undefined : stepTrigger.stepName,
        });
        if ("marketId" in res && res.marketId) {
          scheduler = await recordBetOpened(service, roomId, scheduler);
          return {
            action: "opened_next_step_concurrent",
            marketId: res.marketId,
            queued: updatedQueue.length,
            settled: settleNotes,
          };
        }
      }
    }

    return { action: "market_open_queued", queued: updatedQueue.length, settled: settleNotes };
  }

  if (phaseNow === "waiting_for_next_market") {
    // Prefer vision overtake markets when lead vehicle is prediction-ready.
    const overtake = await tryOpenOvertakeFromLeadState(service, roomId, sessionId);
    if (overtake) {
      return { action: "market_open_overtake_30s", ...overtake, settled: settleNotes };
    }

    const result = await tryOpenPendingBets(
      service,
      roomId,
      sessionId,
      currentQueue,
      rawFreshTriggers,
      openCtx,
      scheduler,
      routeCtx,
      firedKeys,
    );
    return {
      action: result.action,
      ...(result.detail ?? {}),
      settled: settleNotes,
    };
  }

  if (phaseNow === "market_locked" && marketIdNow) {
    // Check market type before settling.  Engine-driven markets (zone_exit_time)
    // must wait for sweepPendingSettlements / shouldSettleEngineMarket — settling
    // here would fire before the driver has had a chance to exit the zone.
    const { data: lockedMarket } = await service
      .from("live_betting_markets")
      .select("market_type")
      .eq("id", marketIdNow)
      .maybeSingle();
    const lockedType = (lockedMarket as { market_type?: string } | null)?.market_type ?? "";

    if (isEngineMarketType(lockedType)) {
      console.log(
        `[tick] engine market ${marketIdNow} (${lockedType}) locked — awaiting sweep; draining queue`,
        { roomId },
      );
      const result = await tryOpenPendingBets(
        service,
        roomId,
        sessionId,
        currentQueue,
        rawFreshTriggers,
        openCtx,
        scheduler,
        routeCtx,
        firedKeys,
      );
      return {
        action: result.action === "no_eligible_bet"
          ? "engine_market_locked_awaiting_sweep"
          : result.action,
        marketId: marketIdNow,
        ...(result.detail ?? {}),
        settled: settleNotes,
      };
    }

    // Non-engine: settle immediately (legacy path for next_turn / city_grid stuck in locked).
    const r = await revealAndSettleMarket(marketIdNow);
    if ("error" in r) {
      // Unstick: market may already be settled or the row disappeared.
      await service
        .from("live_rooms")
        .update({
          phase: "waiting_for_next_market",
          current_market_id: null,
          last_event_at: new Date().toISOString(),
        })
        .eq("id", roomId);
    }
    return { action: "legacy_locked_settle", ...r, settled: settleNotes };
  }

  return { action: "noop", phase: phaseNow, settled: settleNotes };
}

// ─── Queue helpers ────────────────────────────────────────────────────────────

type FreshTrigger = {
  type: "next_turn" | "next_zone" | "zone_exit_time" | "straight_streak" | "next_step";
  pinKey?: string;
  pinId?: number;
  pinLat?: number;
  pinLng?: number;
  cellKey?: string;
  phase?: string;
  capturedZone?: string | null;
  /** straight_streak only: de-dupe key for this straight sequence. */
  streakKey?: string;
  /** straight_streak only: pre-computed analysis to pass through to opener. */
  expectedStreak?: number;
  crossroads?: import("@/lib/live/routing/straightStreakAnalyzer").CrossroadBearing[];
  /** next_step only: OSRM step maneuver data. */
  stepKey?: string;
  stepLat?: number;
  stepLng?: number;
  maneuverType?: string;
  maneuverModifier?: string;
  stepName?: string;
};

function triggerKey(t: QueuedTrigger): string {
  if (t.type === "next_turn") return `next_turn:${t.pinKey}`;
  if (t.type === "next_zone") return `next_zone:${t.cellKey}`;
  if (t.type === "straight_streak") return `straight_streak:${t.streakKey}`;
  if (t.type === "next_step") return `next_step:${t.stepKey}`;
  return `zone_exit_time:${t.cellKey}:${t.phase}`;
}

function freshTriggerKey(t: FreshTrigger): string {
  if (t.type === "next_turn") return `next_turn:${t.pinKey}`;
  if (t.type === "next_zone") return `next_zone:${t.cellKey}`;
  if (t.type === "straight_streak") return `straight_streak:${t.streakKey}`;
  if (t.type === "next_step") return `next_step:${t.stepKey}`;
  return `zone_exit_time:${t.cellKey}:${t.phase}`;
}

function buildUpdatedQueue(
  existing: QueuedTrigger[],
  fresh: FreshTrigger[],
): QueuedTrigger[] {
  const now = Date.now();
  const alive = existing.filter((t) => now - t.queuedAt < QUEUE_EXPIRY_MS);
  const existingKeys = new Set(alive.map(triggerKey));

  for (const ft of fresh) {
    const key = freshTriggerKey(ft);
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);
    if (ft.type === "next_turn") {
      alive.push({
        type: "next_turn",
        pinKey: ft.pinKey!,
        pinId: ft.pinId!,
        pinLat: ft.pinLat!,
        pinLng: ft.pinLng!,
        queuedAt: now,
      });
    } else if (ft.type === "next_zone") {
      alive.push({ type: "next_zone", cellKey: ft.cellKey!, queuedAt: now });
    } else if (ft.type === "straight_streak") {
      alive.push({
        type: "straight_streak",
        streakKey: ft.streakKey!,
        queuedAt: now,
        expectedStreak: ft.expectedStreak,
        crossroads: ft.crossroads,
      });
    } else if (ft.type === "next_step") {
      alive.push({
        type: "next_step",
        stepKey: ft.stepKey!,
        stepLat: ft.stepLat!,
        stepLng: ft.stepLng!,
        maneuverType: ft.maneuverType!,
        maneuverModifier: ft.maneuverModifier,
        stepName: ft.stepName ?? "",
        queuedAt: now,
      });
    } else {
      // zone_exit_time: only allow ONE phase per cell in the queue at a time.
      // If a phase for this cell is already queued, skip later phases — they
      // pile up when the driver transits quickly and the earlier phase hasn't
      // been attempted yet.  The later phases will be re-detected and re-queued
      // naturally once the earlier phase resolves and the slot clears.
      const sameCellAlreadyQueued = alive.some(
        (t) => t.type === "zone_exit_time" && (t as { cellKey?: string }).cellKey === ft.cellKey,
      );
      if (sameCellAlreadyQueued) {
        continue;
      }
      alive.push({
        type: "zone_exit_time",
        phase: ft.phase! as ZoneExitPhase,
        cellKey: ft.cellKey!,
        capturedZone: ft.capturedZone ?? null,
        queuedAt: now,
      });
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
  openCtx: BetOpenContext,
): Promise<{ action: string; detail?: Record<string, unknown>; scheduler?: BetSchedulerState }> {
  const now = Date.now();
  let scheduler = await loadBetSchedulerState(service, roomId);

  // Re-read phase to guard against interleaved ticks that slipped through
  // before the lock was added.
  const { data: latestRoom } = await service
    .from("live_rooms")
    .select("phase")
    .eq("id", roomId)
    .maybeSingle();
  if ((latestRoom as { phase: string } | null)?.phase !== "waiting_for_next_market") {
    return {
      action: "already_opening",
      detail: { phase: (latestRoom as { phase: string } | null)?.phase },
    };
  }

  // Non-expired queue items only.
  const validQueue = [...queue].filter((t) => now - t.queuedAt < QUEUE_EXPIRY_MS);

  // ── Merge queue + fresh into one priority-ordered list ─────────────────────
  //
  // IMPORTANT: we no longer wipe queued_triggers upfront.  The old approach
  // (wipe → open → restore-on-fail) lost the queue if the function crashed
  // after the wipe but before the restore.  Now we leave the DB queue intact
  // throughout, then write the final pruned version ONCE at the end (success or
  // all-fail).  A crash mid-opener leaves the queue unchanged — safe to retry.
  type UnifiedItem =
    | { source: "queue"; trigger: QueuedTrigger; priority: number }
    | { source: "fresh"; trigger: FreshTrigger; priority: number };

  const unified: UnifiedItem[] = [
    ...validQueue.map((t) => ({ source: "queue" as const, trigger: t, priority: triggerPriority(t) })),
    ...fresh.map((t) => ({ source: "fresh" as const, trigger: t, priority: freshPriority(t) })),
  ].sort((a, b) => a.priority - b.priority);

  const openerErrors: Array<{ trigger: string; error: string }> = [];

  for (let i = 0; i < unified.length; i++) {
    const item = unified[i]!;
    const triggerType = item.trigger.type as BetTriggerType;
    const gate = evaluateBetOpen(triggerType, openCtx);
    if (!gate.allowed) {
      continue;
    }

    // remaining = how many lower-priority items are still waiting
    const remaining = unified.length - 1 - i;

    let res: { marketId?: string } | { error?: string };
    if (item.source === "queue") {
      res = await openQueuedTrigger(item.trigger, roomId, remaining);
    } else {
      res = await openFreshTrigger(item.trigger, roomId, remaining);
    }

    if ("marketId" in res && res.marketId) {
      scheduler = await recordBetOpened(service, roomId, scheduler, now);
      // Success: write the queue minus the trigger we just opened + expired items.
      const openedKey = item.source === "queue" ? triggerKey(item.trigger) : null;
      const remainingQueue = validQueue.filter(
        (t) => openedKey == null || triggerKey(t) !== openedKey,
      );
      await service
        .from("live_rooms")
        .update({ queued_triggers: remainingQueue })
        .eq("id", roomId);
      const label = item.source === "queue" ? "_from_queue" : "";
      return {
        action: `opened_${item.trigger.type}${label}`,
        detail: { marketId: res.marketId, trigger: item.trigger },
        scheduler,
      };
    }

    const tKey =
      item.source === "queue"
        ? triggerKey(item.trigger)
        : freshTriggerKey(item.trigger);
    openerErrors.push({
      trigger: tKey,
      error: (res as { error?: string }).error ?? "unknown",
    });
  }

  // Every opener failed — write the queue with permanently-failed SKIP: entries
  // removed.  Transient failures keep their queue entry so the next tick retries.
  const permanentlyFailedKeys = new Set(
    openerErrors
      .filter((e) => e.error.startsWith("SKIP:"))
      .map((e) => e.trigger),
  );
  const finalQueue = validQueue.filter(
    (t) => !permanentlyFailedKeys.has(triggerKey(t)),
  );
  if (permanentlyFailedKeys.size > 0) {
    console.log("[tick] permanently dropping SKIP: triggers", [...permanentlyFailedKeys]);
  }
  if (finalQueue.length !== queue.length || permanentlyFailedKeys.size > 0) {
    await service
      .from("live_rooms")
      .update({ queued_triggers: finalQueue })
      .eq("id", roomId);
  }
  if (openerErrors.length > 0) {
    console.warn("[tick] all openers failed — queue preserved for retry", JSON.stringify(openerErrors));
  }

  return {
    action: "no_eligible_bet",
    detail: { queueSize: queue.length, freshCount: fresh.length, openerErrors },
  };
}

function triggerPriority(t: QueuedTrigger): number {
  // next_zone is the city_grid market type in disguise.
  const mType = t.type === "next_zone" ? "city_grid" : t.type;
  const base = betSchedulePriority(mType);
  // Forward-pin fillers (stepKey "fwd:") fire right after zone_exit_time (1)
  // but before next_turn (2), OSRM steps (3), streak (4), city_grid (5).
  // Camera pins (stepKey "cam:") are more natural than a generic forward-pin
  // so they fire at 1.3 — just before fwd: (1.5), after zone (1).
  if (t.type === "next_step" && t.stepKey.startsWith("cam:")) return 1.3;
  if (t.type === "next_step" && t.stepKey.startsWith("fwd:")) return 1.5;
  if (t.type === "zone_exit_time") {
    const phases: ZoneExitPhase[] = ["entry", "center_70m", "exit_outer"];
    return base + phases.indexOf(t.phase as ZoneExitPhase) * 0.1;
  }
  return base;
}

function freshPriority(t: FreshTrigger): number {
  const mType = t.type === "next_zone" ? "city_grid" : t.type;
  const base = betSchedulePriority(mType);
  // Camera pins fire after zone (1) but before fwd: forward-pins (1.5).
  if (t.type === "next_step" && (t.stepKey ?? "").startsWith("cam:")) return 1.3;
  // Forward-pin fillers fire right after zone_exit_time (1), before everything else.
  if (t.type === "next_step" && (t.stepKey ?? "").startsWith("fwd:")) return 1.5;
  if (t.type === "zone_exit_time") {
    const phases: ZoneExitPhase[] = ["entry", "center_70m", "exit_outer"];
    return base + phases.indexOf(t.phase as ZoneExitPhase) * 0.1;
  }
  return base;
}

/**
 * Compute the bet window for this open event.
 * Rule: at least BET_OPEN_WINDOW_MS (10 s), up to BET_OPEN_WINDOW_IDLE_MS (14 s)
 * when there is nothing else queued.
 */
function betWindowMs(remainingQueueSize: number): number {
  return remainingQueueSize > 0 ? BET_OPEN_WINDOW_MS : BET_OPEN_WINDOW_IDLE_MS;
}

async function openQueuedTrigger(
  trigger: QueuedTrigger,
  roomId: string,
  remainingQueueSize: number,
) {
  const windowMs = betWindowMs(remainingQueueSize);
  if (trigger.type === "next_turn") {
    return openNextTurnMarketForRoom(roomId, { queuedPinId: trigger.pinId, windowMs });
  }
  if (trigger.type === "next_step") {
    return openNextStepMarketForRoom(roomId, {
      windowMs,
      stepKey: trigger.stepKey,
      stepLat: trigger.stepLat,
      stepLng: trigger.stepLng,
      maneuverType: trigger.maneuverType,
      maneuverModifier: trigger.maneuverModifier,
      stepName: trigger.stepName,
    });
  }
  if (trigger.type === "next_zone") return openCityGridMarketForRoom(roomId, { windowMs });
  if (trigger.type === "straight_streak") {
    return openStraightStreakMarketForRoom(roomId, {
      windowMs,
      streakKey: trigger.streakKey,
      preComputedExpectedStreak: trigger.expectedStreak,
      preComputedCrossroads: trigger.crossroads,
    });
  }
  return openEngineMarketForRoom(roomId, { phase: trigger.phase, windowMs });
}

async function openFreshTrigger(
  ft: FreshTrigger,
  roomId: string,
  remainingFreshCount: number,
) {
  const windowMs = betWindowMs(remainingFreshCount);
  if (ft.type === "next_turn") return openNextTurnMarketForRoom(roomId, { windowMs });
  if (ft.type === "next_step") {
    return openNextStepMarketForRoom(roomId, {
      windowMs,
      stepKey: ft.stepKey,
      stepLat: ft.stepLat,
      stepLng: ft.stepLng,
      maneuverType: ft.maneuverType,
      maneuverModifier: ft.maneuverModifier,
      stepName: ft.stepName,
    });
  }
  if (ft.type === "next_zone") return openCityGridMarketForRoom(roomId, { windowMs });
  if (ft.type === "straight_streak") {
    return openStraightStreakMarketForRoom(roomId, {
      windowMs,
      streakKey: ft.streakKey,
      preComputedExpectedStreak: ft.expectedStreak,
      preComputedCrossroads: ft.crossroads,
    });
  }
  return openEngineMarketForRoom(roomId, { phase: ft.phase as ZoneExitPhase, windowMs });
}

// ─── Gap-filler ───────────────────────────────────────────────────────────────

/** Look-ahead distance used when projecting a forward OSRM probe target (m). */
const FILLER_FORWARD_PROBE_M = 1_500;

/**
 * Try to open a `next_step` bet using the RELAXED filler distance window
 * from `betScheduleConfig`.  Called only when no normal trigger is available
 * (`openFromQueueOrTriggers` returned `no_eligible_bet`).
 *
 * Two paths:
 *
 *   Happy path   — reuses `routeCtx.planningPolyline` + `routeCtx.osrmSteps`
 *                  already fetched by `detectEligibleTriggers`, zero extra
 *                  network calls.
 *
 *   Fallback path — when the route planning failed (planningPolyline = null),
 *                  fetches OSRM steps independently using GPS + heading and
 *                  skips the planning-polyline alignment check.  Ensures the
 *                  filler still fires even when `computeDriverRouteInstruction`
 *                  is unavailable (Overpass down, no destination, etc.).
 */
async function tryFillerNextStep(
  service: Awaited<ReturnType<typeof createServiceClient>>,
  roomId: string,
  sessionId: string,
  routeCtx: RouteCtx | null,
  fired: FiredKeysSnapshot,
  openCtx: BetOpenContext,
  scheduler: BetSchedulerState,
): Promise<{ action: string; detail?: Record<string, unknown> } | null> {
  if (!NEXT_STEP_BETS_ENABLED) return null;
  if (!routeCtx) return null;
  if (!evaluateBetOpen("next_step", openCtx).allowed) return null;

  // ── PRIMARY: forward-pin retry (200 m ahead on Google Maps polyline) ────────
  //
  // The forward-pin is normally opened via the fresh-trigger path in
  // detectEligibleTriggers (priority 10).  This block is a retry: it only
  // runs when openFromQueueOrTriggers returned no_eligible_bet (all triggers,
  // including the forward-pin fresh trigger, failed for transient reasons).
  //
  // If the retry succeeds here, great.  If not (or if fwd is null / already
  // fired), we fall through to the OSRM fallback below — never returning null
  // early with a planningPolyline present.
  if (routeCtx.planningPolyline && routeCtx.planningPolyline.length >= 2) {
    const fwd = findForwardPinCandidate(
      routeCtx.planningPolyline,
      routeCtx.lat,
      routeCtx.lng,
    );

    if (fwd) {
      if (!fired.nextStep.has(fwd.stepKey)) {
        console.log(
          `[tick:filler] next_step: forward-pin retry ${fwd.stepKey} at ${Math.round(fwd.roadMeters)}m ahead — opening`,
          { roomId },
        );

        const res = await openNextStepMarketForRoom(roomId, {
          windowMs: BET_OPEN_WINDOW_IDLE_MS,
          stepKey: fwd.stepKey,
          stepLat: fwd.stepLat,
          stepLng: fwd.stepLng,
          maneuverType: "continue",
          maneuverModifier: "straight",
          stepName: undefined,
        });

        if ("marketId" in res && res.marketId) {
          await recordBetOpened(service, roomId, scheduler);
          return { action: "opened_next_step_filler_fwd", detail: { marketId: res.marketId } };
        }

        console.warn(`[tick:filler] next_step: forward-pin retry failed for ${fwd.stepKey}`, res, { roomId });
      } else {
        console.log(`[tick:filler] next_step: forward-pin ${fwd.stepKey} already fired — falling through to OSRM`, { roomId });
      }
    } else {
      console.log(`[tick:filler] next_step: forward-pin projection failed — falling through to OSRM`, { roomId });
    }
    // When a planning polyline exists but the forward-pin couldn't open (already
    // fired for this bucket, or too close to a turn), do NOT fall through to the
    // OSRM junction fallback — OSRM places pins at fixed road-intersection coords
    // which feel like "predestined places" to the user.  Skip and wait for the
    // next bucket (driver advances ~100 m) or the next tick where conditions differ.
    return null;
  }

  // ── SECONDARY: OSRM-step fallback ─────────────────────────────────────────
  //
  // Only reached when there is NO planning polyline at all (Google Maps route
  // hasn't loaded yet).  Never used when a polyline is available — OSRM pins
  // land at fixed junction coords which repeat every ride ("predestined places").
  const minM = NEXT_STEP_MIN_ROAD_M;
  const maxM = NEXT_STEP_FILLER_MAX_ROAD_M;

  let steps = routeCtx.osrmSteps;

  if (!steps) {
    const { heading, lat, lng } = routeCtx;
    if (heading == null) {
      console.log(`[tick:filler] next_step: no polyline, no heading — skipping`, { roomId });
      return null;
    }

    const forwardTarget = projectPoint({ lat, lng }, heading, FILLER_FORWARD_PROBE_M);
    try {
      const osrmResult = await fetchOsrmDrivingRouteWithSteps({ lat, lng }, forwardTarget);
      if (!osrmResult) return null;
      steps = osrmResult.steps;
      console.log(`[tick:filler] next_step: fetched ${steps.length} OSRM steps via forward-probe`, { roomId });
    } catch (err) {
      console.error(`[tick:filler] next_step: OSRM fetch failed`, err, { roomId });
      return null;
    }
  }

  // Use straight-line distance since there is no planning polyline.
  const candidates = findNextStepCandidates(steps, null, routeCtx.lat, routeCtx.lng, minM, maxM);

  for (const candidate of candidates) {
    if (fired.nextStep.has(candidate.stepKey)) continue;

    console.log(
      `[tick:filler] next_step (OSRM fallback): ${candidate.stepKey} (${candidate.maneuverType}) road dist ${Math.round(candidate.roadMeters)}m`,
      { roomId },
    );

    const res = await openNextStepMarketForRoom(roomId, {
      windowMs: BET_OPEN_WINDOW_IDLE_MS,
      stepKey: candidate.stepKey,
      stepLat: candidate.stepLat,
      stepLng: candidate.stepLng,
      maneuverType: candidate.maneuverType,
      maneuverModifier: candidate.maneuverModifier,
      stepName: candidate.stepName,
    });

    if ("marketId" in res && res.marketId) {
      await recordBetOpened(service, roomId, scheduler);
      return { action: "opened_next_step_filler_osrm", detail: { marketId: res.marketId } };
    }

    console.warn(`[tick:filler] next_step: OSRM opener failed for ${candidate.stepKey}`, res, { roomId });
  }

  return null;
}

// ─── Route context returned from detection ────────────────────────────────────

type RouteCtx = {
  lat: number;
  lng: number;
  /** Driver heading in degrees (null when the vehicle is stationary). */
  heading: number | null;
  /** Decoded Google / OSRM planning polyline for the next ~1500 m. */
  planningPolyline: LatLng[] | null;
  /** OSRM step list fetched for the same segment.  Null when unavailable. */
  osrmSteps: OsrmStep[] | null;
};

type DetectResult = {
  eligible: FreshTrigger[];
  routeCtx: RouteCtx | null;
  scheduler: BetSchedulerState;
};

async function resolveMainMarketType(
  service: Awaited<ReturnType<typeof createServiceClient>>,
  marketId: string | null,
): Promise<string | null> {
  if (!marketId) return null;
  const { data } = await service
    .from("live_betting_markets")
    .select("market_type")
    .eq("id", marketId)
    .maybeSingle();
  return (data as { market_type: string } | null)?.market_type ?? null;
}

async function resolveStepMarketOpen(
  service: Awaited<ReturnType<typeof createServiceClient>>,
  stepMarketId: string | null,
): Promise<boolean> {
  if (!stepMarketId) return false;
  const { data } = await service
    .from("live_betting_markets")
    .select("status")
    .eq("id", stepMarketId)
    .maybeSingle();
  return (data as { status: string } | null)?.status === "open";
}

async function tryOpenPendingBets(
  service: Awaited<ReturnType<typeof createServiceClient>>,
  roomId: string,
  sessionId: string,
  currentQueue: QueuedTrigger[],
  freshTriggers: FreshTrigger[],
  openCtx: BetOpenContext,
  scheduler: BetSchedulerState,
  routeCtx: RouteCtx | null,
  firedKeys: FiredKeysSnapshot,
): Promise<{ action: string; detail?: Record<string, unknown>; scheduler: BetSchedulerState }> {
  let workingScheduler = scheduler;
  const opened = await openFromQueueOrTriggers(
    service,
    roomId,
    currentQueue,
    freshTriggers,
    openCtx,
  );
  if (opened.scheduler) {
    workingScheduler = opened.scheduler;
  }

  if (opened.action !== "no_eligible_bet") {
    return { ...opened, scheduler: workingScheduler };
  }

  const fillerOpened = await tryFillerNextStep(
    service,
    roomId,
    sessionId,
    routeCtx,
    firedKeys,
    openCtx,
    workingScheduler,
  );
  if (fillerOpened) {
    return {
      action: fillerOpened.action,
      detail: fillerOpened.detail,
      scheduler: workingScheduler,
    };
  }

  if (NEXT_STEP_BETS_ENABLED) {
    const stepTrigger = freshTriggers.find((t) => t.type === "next_step");
    if (stepTrigger && evaluateBetOpen("next_step", openCtx).allowed) {
      const res = await openNextStepMarketForRoom(roomId, {
        windowMs: BET_OPEN_WINDOW_IDLE_MS,
        stepKey: stepTrigger.stepKey,
        stepLat: stepTrigger.stepLat,
        stepLng: stepTrigger.stepLng,
        maneuverType: stepTrigger.maneuverType,
        maneuverModifier: stepTrigger.maneuverModifier,
        stepName: stepTrigger.maneuverType === "camera" ? undefined : stepTrigger.stepName,
      });
      if ("marketId" in res && res.marketId) {
        workingScheduler = await recordBetOpened(service, roomId, workingScheduler);
        return {
          action: "opened_next_step",
          detail: { marketId: res.marketId },
          scheduler: workingScheduler,
        };
      }
    }
  }

  return { action: opened.action, detail: opened.detail, scheduler: workingScheduler };
}

// ─── Pure helper: filter OSRM steps to eligible next_step candidates ─────────

/**
 * Scan an OSRM step list and return every step whose maneuver point is an
 * eligible `next_step` bet target.
 *
 * When `planningPolyline` is provided (primary path):
 *   • Distance is measured as **road distance** along the planning polyline
 *     from the driver's current position (NOT straight-line).  This guarantees
 *     the pin is always AHEAD of the vehicle — a negative road distance means
 *     the step is behind the driver and is automatically excluded.
 *   • The step's maneuver point is projected onto the polyline so the pin
 *     coordinate sits exactly on the planned road (Google Maps geometry).
 *   • Steps whose maneuver location is > NEXT_STEP_ON_ROUTE_M perpendicular
 *     distance from the polyline are excluded (different road / parallel street).
 *
 * When `planningPolyline` is null (fallback / forward-probe path):
 *   • Falls back to straight-line distance.  No on-route check is applied.
 *   • The raw OSRM maneuver coordinate is used as the pin location.
 *   • Pins behind the vehicle are NOT filtered in this mode (no polyline to
 *     determine direction); callers should ensure the OSRM route faces forward.
 *
 * Results are sorted by road distance ascending so the caller can take [0]
 * for the nearest eligible step.
 */
function findNextStepCandidates(
  osrmSteps: OsrmStep[],
  planningPolyline: LatLng[] | null,
  lat: number,
  lng: number,
  minRoadM: number,
  maxRoadM: number,
): Array<{
  stepKey: string;
  stepLat: number;
  stepLng: number;
  maneuverType: string;
  maneuverModifier: string | undefined;
  stepName: string | undefined;
  roadMeters: number;
}> {
  const driver = { lat, lng };
  const results: Array<{
    stepKey: string; stepLat: number; stepLng: number;
    maneuverType: string; maneuverModifier: string | undefined;
    stepName: string | undefined; roadMeters: number;
  }> = [];

  for (const step of osrmSteps) {
    if (isBookendManeuver(step.maneuver.type)) continue;

    const key = `step:${step.maneuver.location.lat.toFixed(4)}:${step.maneuver.location.lng.toFixed(4)}`;

    if (planningPolyline) {
      // ── PRIMARY: road-distance along the Google Maps planning polyline ────
      // roadDistanceAlongPolyline returns a signed value:
      //   positive → step is AHEAD  (the only valid case)
      //   negative → step is BEHIND (driver already passed it — skip)
      const rd = roadDistanceAlongPolyline(planningPolyline, driver, step.maneuver.location);
      if (!rd) continue;
      if (rd.onRouteMeters > NEXT_STEP_ON_ROUTE_M) continue; // too far from route (parallel road)
      if (rd.roadMeters < minRoadM || rd.roadMeters > maxRoadM) continue; // outside trigger window
      // rd.roadMeters > 0 is guaranteed because minRoadM > 0 (e.g. 80 m).
      results.push({
        stepKey: key,
        stepLat: rd.projection.lat,  // snapped onto the Google Maps polyline
        stepLng: rd.projection.lng,
        maneuverType: step.maneuver.type,
        maneuverModifier: step.maneuver.modifier,
        stepName: step.name,
        roadMeters: rd.roadMeters,
      });
    } else {
      // ── FALLBACK: straight-line distance (no reference polyline) ──────────
      const dist = metersBetween(driver, step.maneuver.location);
      if (dist < minRoadM || dist > maxRoadM) continue;
      results.push({
        stepKey: key,
        stepLat: step.maneuver.location.lat,
        stepLng: step.maneuver.location.lng,
        maneuverType: step.maneuver.type,
        maneuverModifier: step.maneuver.modifier,
        stepName: step.name,
        roadMeters: dist, // straight-line used as proxy in fallback mode
      });
    }
  }

  // Sort by road distance ascending so callers can take results[0] for nearest.
  return results.sort((a, b) => a.roadMeters - b.roadMeters);
}

// ─── Forward-pin filler ───────────────────────────────────────────────────────

/**
 * Compute a "forward pin" — a point exactly NEXT_STEP_FORWARD_PIN_ROAD_M metres
 * ahead of the driver along the Google Maps planning polyline.
 *
 * This is the primary gap-filler strategy.  It requires only the planning
 * polyline (always available when Google Routes responds) and is guaranteed to
 * produce a pin that is ahead of the driver, on the planned road.
 *
 * The stepKey is bucketed by NEXT_STEP_FORWARD_PIN_BUCKET_M so a new market
 * opens at most once per bucket of travel (prevents rapid re-triggering while
 * the previous bet is still live).
 */
/**
 * Maximum bearing deviation (degrees) from the overall start→end direction
 * for a route stretch to be classified as "straight".
 *
 * 30° is generous enough to handle gentle city bends but strict enough to
 * block forward-pin bets when a real turn is coming within 300 m.
 */
const FORWARD_PIN_STRAIGHT_DEG_THRESHOLD = 30;

/**
 * Returns true when no segment of `polyline` deviates more than `thresholdDeg`
 * from the overall start→end bearing.  Used to gate forward-pin bets so they
 * only appear on visibly straight stretches of road.
 */
function isPolylineStraight(polyline: LatLng[], thresholdDeg: number): boolean {
  if (polyline.length < 2) return false;
  const overall = bearingDegrees(polyline[0]!, polyline[polyline.length - 1]!);
  for (let i = 1; i < polyline.length; i++) {
    const seg = bearingDegrees(polyline[i - 1]!, polyline[i]!);
    let diff = Math.abs(seg - overall) % 360;
    if (diff > 180) diff = 360 - diff;
    if (diff > thresholdDeg) return false;
  }
  return true;
}

function findForwardPinCandidate(
  planningPolyline: LatLng[],
  driverLat: number,
  driverLng: number,
): {
  stepKey: string;
  stepLat: number;
  stepLng: number;
  roadMeters: number;
} | null {
  const driverProj = projectOntoPolyline(planningPolyline, { lat: driverLat, lng: driverLng });
  if (!driverProj) return null;

  const driverAlong = cumulativeMetersAt(
    planningPolyline,
    driverProj.segmentIndex,
    driverProj.t,
  );

  // Slice from driver position to NEXT_STEP_FORWARD_PIN_ROAD_M ahead.
  const ahead = slicePolylineByDistance(
    planningPolyline,
    driverAlong,
    driverAlong + NEXT_STEP_FORWARD_PIN_ROAD_M,
  );
  if (ahead.length === 0) return null;

  // Place the pin at whatever is 300 m ahead on the route (interpolated point).
  const pin = ahead[ahead.length - 1]!;

  // Dedup key: driver-position bucket (≈110 m grid) + a 45-second time bucket.
  //
  // Why time-bucket?
  //   • A pure geographic key means each ≈110 m section of a road fires at most
  //     ONCE per session — on repeated rides the user sees pins at the exact same
  //     road spots every time ("predestined places").
  //   • The time bucket (~1 bet cycle) lets positions re-fire after each bet
  //     resolves, so forward pins flow continuously and feel dynamic.
  //   • A stationary driver re-fires the same position every 45 s (max once per
  //     bet cycle) — still sensible behaviour.
  const timeBucket = Math.floor(Date.now() / 45_000);
  const dBucketLat = (Math.round(driverLat / 0.001) * 0.001).toFixed(3);
  const dBucketLng = (Math.round(driverLng / 0.001) * 0.001).toFixed(3);
  const stepKey = `fwd:${timeBucket}:${dBucketLat}:${dBucketLng}`;

  return { stepKey, stepLat: pin.lat, stepLng: pin.lng, roadMeters: NEXT_STEP_FORWARD_PIN_ROAD_M };
}

// ─── Camera detection on route ───────────────────────────────────────────────
//
// Two sources checked in parallel:
//   1. TfL JamCam API — the SAME ~900 London traffic cameras shown in the
//      client PiP panel.  This is what the user sees and expects a bet for.
//   2. OSM Overpass — speed-enforcement cameras as a secondary source.
//
// Detection range: 30 m → 500 m ahead on the planning polyline.
// Lower minimum (30 m) ensures the bet still fires when the room was busy during
// the normal approach window.  Larger maximum (500 m) gives more queue lifetime.
// Offset tolerance is 100 m — TfL JamCam cameras sit at junctions and can be
// well off the road centreline.

const _camOnRouteCache = new Map<string, { result: LatLng | null; expiresAt: number }>();
const CAM_CACHE_MS = 30_000;

// Global TfL camera list — fetched once, cached for 5 minutes.
let _tflCameras: Array<{ lat: number; lng: number }> | null = null;
let _tflCamerasAt = 0;
const TFL_CAMERAS_TTL = 5 * 60_000;

async function fetchTflCamerasForTick(): Promise<Array<{ lat: number; lng: number }>> {
  if (_tflCameras && Date.now() - _tflCamerasAt < TFL_CAMERAS_TTL) return _tflCameras;
  try {
    const res = await fetch("https://api.tfl.gov.uk/Place/Type/JamCam", {
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) return _tflCameras ?? [];
    const data = (await res.json()) as Array<{ lat: number; lon: number; additionalProperties?: Array<{ key: string; value: string }> }>;
    _tflCameras = data
      .filter((c) => {
        if (!Number.isFinite(c.lat) || !Number.isFinite(c.lon)) return false;
        // Skip unavailable cameras.
        const avail = c.additionalProperties?.find((p) => p.key === "available")?.value;
        return avail !== "false";
      })
      .map((c) => ({ lat: c.lat, lng: c.lon }));
    _tflCamerasAt = Date.now();
    console.log(`[tick:cam] fetched ${_tflCameras.length} TfL cameras`);
    return _tflCameras;
  } catch {
    return _tflCameras ?? [];
  }
}

async function findCameraOnRoute(
  polyline: LatLng[],
  driverLat: number,
  driverLng: number,
): Promise<LatLng | null> {
  // Coarse cache key: 0.002° grid (≈ 200 m)
  const cacheKey = `${(Math.round(driverLat / 0.002) * 0.002).toFixed(3)}:${(Math.round(driverLng / 0.002) * 0.002).toFixed(3)}`;
  const cached = _camOnRouteCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.result;

  const driverProj = projectOntoPolyline(polyline, { lat: driverLat, lng: driverLng });
  if (!driverProj) {
    _camOnRouteCache.set(cacheKey, { result: null, expiresAt: Date.now() + CAM_CACHE_MS });
    return null;
  }
  const driverAlong = cumulativeMetersAt(polyline, driverProj.segmentIndex, driverProj.t);

  // Look-ahead band: 30 m minimum so cameras still fire when the room was busy
  // during the full 80-300 m window; 500 m maximum so cameras are detected well
  // in advance and can survive a zone bet's queue lifetime.
  // TfL JamCam cameras sit at junctions and can be 70-90 m off the road
  // centreline, so the offset limit is relaxed to 100 m.
  const CAM_LOOK_MIN_M = 30;
  const CAM_LOOK_MAX_M = 500;
  const CAM_MAX_OFFSET_M = 100;

  // Helper: project a point onto the polyline and return road distance ahead.
  function cameraRoadDistAhead(camLat: number, camLng: number): number | null {
    const proj = projectOntoPolyline(polyline, { lat: camLat, lng: camLng });
    if (!proj) return null;
    // Straight-line distance from the projection to the actual camera position.
    const offsetM = metersBetween({ lat: camLat, lng: camLng }, proj.projection);
    if (offsetM > CAM_MAX_OFFSET_M) return null; // different road
    const camAlong = cumulativeMetersAt(polyline, proj.segmentIndex, proj.t);
    const distAhead = camAlong - driverAlong;
    if (distAhead < CAM_LOOK_MIN_M || distAhead > CAM_LOOK_MAX_M) return null;
    return distAhead;
  }

  let result: LatLng | null = null;
  let bestDist = Infinity;

  // ── Source 1: TfL JamCam traffic monitoring cameras ─────────────────────
  try {
    const tflCams = await fetchTflCamerasForTick();
    for (const c of tflCams) {
      // Quick bounding-box pre-filter (≈ 500 m) before expensive projection.
      if (Math.abs(c.lat - driverLat) > 0.006 || Math.abs(c.lng - driverLng) > 0.009) continue;
      const dist = cameraRoadDistAhead(c.lat, c.lng);
      if (dist !== null && dist < bestDist) {
        bestDist = dist;
        result = { lat: c.lat, lng: c.lng };
      }
    }
  } catch {
    // TfL unavailable — fall through to Overpass
  }

  // ── Source 2: OSM Overpass speed-enforcement cameras ────────────────────
  // Only query if TfL found nothing (avoid unnecessary Overpass hits).
  if (!result) {
    try {
      const sliceAhead = slicePolylineByDistance(
        polyline,
        driverAlong + CAM_LOOK_MIN_M,
        driverAlong + CAM_LOOK_MAX_M,
      );
      if (sliceAhead.length > 0) {
        const mid = sliceAhead[Math.floor(sliceAhead.length / 2)]!;
        const query = [
          "[out:json][timeout:5];",
          "(",
          `  node(around:${CAM_MAX_OFFSET_M},${mid.lat},${mid.lng})[highway=speed_camera];`,
          `  node(around:${CAM_MAX_OFFSET_M},${mid.lat},${mid.lng})[enforcement=speed_camera];`,
          `  node(around:${CAM_MAX_OFFSET_M},${mid.lat},${mid.lng})[device=camera][enforcement];`,
          ");",
          "out center 3;",
        ].join("\n");
        const res = await fetch("https://overpass-api.de/api/interpreter", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: `data=${encodeURIComponent(query)}`,
          signal: AbortSignal.timeout(4_000),
        });
        if (res.ok) {
          const data = (await res.json()) as { elements?: Array<{ lat?: number; lon?: number }> };
          const el = data.elements?.[0];
          if (el?.lat != null && el?.lon != null) {
            result = { lat: el.lat, lng: el.lon };
          }
        }
      }
    } catch {
      // Overpass unavailable
    }
  }

  _camOnRouteCache.set(cacheKey, { result, expiresAt: Date.now() + CAM_CACHE_MS });
  return result;
}

// ─── Trigger detection ────────────────────────────────────────────────────────

async function detectEligibleTriggers(
  service: Awaited<ReturnType<typeof createServiceClient>>,
  roomId: string,
  sessionId: string,
  capturedZone: string | null,
  fired: FiredKeysSnapshot,
  scheduler: BetSchedulerState,
): Promise<DetectResult> {
  const eligible: FreshTrigger[] = [];
  let schedulerNext = scheduler;

  const { data: gpsRow } = await service
    .from("live_route_snapshots")
    .select("normalized_lat,normalized_lng,raw_lat,raw_lng,heading_deg")
    .eq("live_session_id", sessionId)
    .order("recorded_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!gpsRow) return { eligible, routeCtx: null, scheduler: schedulerNext };
  const g = gpsRow as {
    normalized_lat: number | null;
    normalized_lng: number | null;
    raw_lat: number;
    raw_lng: number;
    heading_deg: number | null;
  };
  const lat = g.normalized_lat ?? g.raw_lat;
  const lng = g.normalized_lng ?? g.raw_lng;
  const driverHeadingDeg = g.heading_deg;


  // ── Grid triggers ─────────────────────────────────────────────────────────
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
        const nowMs = Date.now();
        schedulerNext = nextCellDwellState(schedulerNext, cellKey, nowMs);

        // zone_exit_time — on cell entry / center / exit (see betWindowConstants).
        const firedPhases = fired.zonePhases.get(cellKey) ?? new Set<ZoneExitPhase>();

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

        // city_grid / next_zone — after cell dwell (betScheduleConfig), not on entry.
        const dwellMs = schedulerNext.cellDwell?.cellKey === cellKey
          ? nowMs - schedulerNext.cellDwell.enteredAtMs
          : 0;
        const dwellRule = triggerCellDwellMs("next_zone") ?? 0;
        if (!fired.cityGrid.has(cellKey) && dwellMs >= dwellRule) {
          eligible.push({ type: "next_zone", cellKey });
        }
      }
    }
  }

  // ── next_turn + straight_streak + next_step triggers ─────────────────────
  //
  // All three route-dependent bet types share a single
  // `computeDriverRouteInstruction` call to avoid fetching the route twice.
  const needsRoute = NEXT_TURN_BETS_ENABLED || STRAIGHT_STREAK_BETS_ENABLED || NEXT_STEP_BETS_ENABLED;
  let drvResult: Awaited<ReturnType<typeof computeDriverRouteInstruction>> | null = null;
  if (needsRoute) {
    try {
      drvResult = await computeDriverRouteInstruction(roomId);
    } catch {
      // routing errors are non-fatal — both bet types degrade gracefully
    }
  }

  if (NEXT_TURN_BETS_ENABLED && drvResult) {
    try {
      const pin = drvResult.instruction?.pins?.[0] ?? null;
      if (pin && Number.isFinite(pin.distanceMeters)) {
        const d = pin.distanceMeters;
        if (d >= NEXT_TURN_PIN_MIN_M && d <= NEXT_TURN_PIN_MAX_M) {
          let pinIsAhead = true;
          if (driverHeadingDeg != null) {
            const bearingToPin =
              metersBetween({ lat, lng }, { lat: pin.lat, lng: pin.lng }) > 1
                ? bearingDegrees({ lat, lng }, { lat: pin.lat, lng: pin.lng })
                : driverHeadingDeg;
            const diff = Math.abs(((driverHeadingDeg - bearingToPin + 540) % 360) - 180);
            if (diff > 90) pinIsAhead = false;
          }
          if (pinIsAhead) {
            const pinKey = `pin:${pin.id}`;
            if (!fired.nextTurn.has(pinKey)) {
              eligible.push({
                type: "next_turn",
                pinKey,
                pinId: pin.id,
                pinLat: pin.lat,
                pinLng: pin.lng,
              });
            }
          }
        }
      }
    } catch {
      // next_turn routing errors are non-fatal
    }
  }

  if (STRAIGHT_STREAK_BETS_ENABLED && drvResult?.instruction) {
    try {
      const { pins } = drvResult.instruction;
      if (pins.length < STRAIGHT_STREAK_MIN_LENGTH) {
        console.log(`[tick:detect] straight_streak: only ${pins.length} pin(s) — need ≥ ${STRAIGHT_STREAK_MIN_LENGTH}`, { roomId });
      } else {
        const analysis = analyzeStreakAhead(drvResult.planningPolyline, pins);
        console.log(`[tick:detect] straight_streak: streakLength=${analysis.streakLength}, streakKey=${analysis.streakKey}`, {
          roomId,
          pinCount: pins.length,
          crossroads: analysis.crossroads.map(c => ({ nodeId: c.nodeId, bearingChangeDeg: c.bearingChangeDeg, isStraight: c.isStraight })),
        });
        if (analysis.streakKey) {
          if (!fired.straightStreak.has(analysis.streakKey)) {
            eligible.push({
              type: "straight_streak",
              streakKey: analysis.streakKey,
              // Carry the analysis so the opener can use it directly without
              // re-running computeDriverRouteInstruction on a potentially
              // different ROOM_STATE snapshot.
              expectedStreak: analysis.streakLength,
              crossroads: analysis.crossroads,
            });
          } else {
            console.log(`[tick:detect] straight_streak: ${analysis.streakKey} already fired this session`, { roomId });
          }
        }
      }
    } catch (err) {
      console.error(`[tick:detect] straight_streak analysis error`, err, { roomId });
    }
  }

  // ── next_step: OSRM step maneuver bet ──────────────────────────────────────
  //
  // OSRM steps are fetched once here and stored in `osrmStepsCache` so the
  // filler path (tryFillerNextStep) can reuse them without a second network call.
  //
  // Target selection priority:
  //   1. Planning polyline end (most accurate — same route Google uses).
  //   2. Forward probe (GPS heading × FILLER_FORWARD_PROBE_M) — used when
  //      computeDriverRouteInstruction failed so the filler still works.
  //
  // When using the forward probe the on-route check is skipped (no reference
  // polyline), which allows all OSRM maneuver points within the trigger window
  // to be eligible regardless of Google/OSRM geometry differences.
  const planningPolyline =
    drvResult && "planningPolyline" in drvResult ? drvResult.planningPolyline : null;
  let osrmStepsCache: OsrmStep[] | null = null;
  // Polyline used for the on-route check in findNextStepCandidates.
  // Null when the OSRM fetch used a forward probe (no reference polyline).
  let osrmPolylineCheck = planningPolyline;

  const hasStreakTrigger = eligible.some((t) => t.type === "straight_streak");
  const needsOsrm = NEXT_STEP_BETS_ENABLED || hasStreakTrigger;

  // Determine OSRM target: polyline end or forward probe.
  let osrmTarget: LatLng | null = null;
  if (needsOsrm) {
    if (planningPolyline && planningPolyline.length >= 2) {
      osrmTarget = planningPolyline[planningPolyline.length - 1]!;
    } else if (driverHeadingDeg != null) {
      osrmTarget = projectPoint({ lat, lng }, driverHeadingDeg, FILLER_FORWARD_PROBE_M);
      osrmPolylineCheck = null; // Forward probe — skip on-route check
    }
  }

  if (needsOsrm && osrmTarget) {
    try {
      const osrmResult = await fetchOsrmDrivingRouteWithSteps({ lat, lng }, osrmTarget);
      if (osrmResult) {
        osrmStepsCache = osrmResult.steps;

        // straight_streak uses sparse route-analysis crossroads (stored on the
        // trigger at detection time). Dense OSRM junctions are side-street
        // granularity and inflate the live counter past expectedStreak (e.g. 6/3).

        // OSRM junction step bets — only used when there is NO Google Maps
        // planning polyline.  When a polyline is available, the dynamic
        // forward-pin (fwd:lat:lng, 300 m ahead) is always preferred because
        // OSRM step keys are fixed geographic junction coordinates that repeat
        // every ride ("predestined places").
        const candidates = osrmPolylineCheck
          ? [] // planning polyline available → skip OSRM junction pins
          : findNextStepCandidates(
              osrmResult.steps,
              null,
              lat,
              lng,
              NEXT_STEP_MIN_ROAD_M,
              NEXT_STEP_MAX_ROAD_M,
            );
        for (const c of candidates) {
          if (!fired.nextStep.has(c.stepKey)) {
            console.log(
              `[tick:detect] next_step (no-polyline fallback): ${c.stepKey} (${c.maneuverType}) road dist ${Math.round(c.roadMeters)}m`,
              { roomId },
            );
            eligible.push({
              type: "next_step",
              stepKey: c.stepKey,
              stepLat: c.stepLat,
              stepLng: c.stepLng,
              maneuverType: c.maneuverType,
              maneuverModifier: c.maneuverModifier,
              stepName: c.stepName,
            });
            break; // Only queue the nearest unfired step per tick.
          } else {
            console.log(`[tick:detect] next_step: ${c.stepKey} already fired this session`, { roomId });
          }
        }
      }
    } catch (err) {
      console.error(`[tick:detect] next_step analysis error`, err, { roomId });
    }
  }

  // ── next_step forward-pin filler (priority 1.5 — beats OSRM junction pins) ───
  //
  // Always add the forward-pin when 300 m of route is available ahead.  The fwd:
  // key has priority 1.5 which is LOWER NUMBER (= higher priority) than the OSRM
  // next_step (priority 3).  Both can coexist in eligible at the same time —
  // openFromQueueOrTriggers will pick the forward-pin first because of the lower
  // priority number, and only fall back to the OSRM junction step if fwd: fails.
  //
  // Previously gated by hasNextStepAlready which BLOCKED the fwd: pin whenever an
  // OSRM step was added first.  That caused OSRM junction points (fixed geographic
  // coordinates) to fire instead of the dynamic 300-m-ahead pin, producing the
  // "predestined places" the user complained about.
  if (NEXT_STEP_BETS_ENABLED && planningPolyline && planningPolyline.length >= 2) {
    {
      const fwd = findForwardPinCandidate(planningPolyline, lat, lng);
      if (fwd) {
        if (!fired.nextStep.has(fwd.stepKey)) {
          eligible.push({
            type: "next_step",
            stepKey: fwd.stepKey,
            stepLat: fwd.stepLat,
            stepLng: fwd.stepLng,
            maneuverType: "continue",
            maneuverModifier: "straight",
            stepName: undefined,
          });
          console.log(
            `[tick:detect] next_step forward-pin ${fwd.stepKey} at ${Math.round(fwd.roadMeters)}m ahead`,
            { roomId },
          );
        } else {
          console.log(
            `[tick:detect] next_step forward-pin ${fwd.stepKey} already fired — skipping`,
            { roomId },
          );
        }
      }
    }
  }

  // ── next_step camera pin: traffic/speed camera on route (priority 1.3) ──────
  //
  // When a camera is 30–500 m ahead on the planning polyline, use it as a
  // next_step target.  Camera bets fire whenever a TfL JamCam or OSM speed
  // camera is on the driver's route.  They outprioritise the generic forward-pin
  // filler (1.5) but yield to zone bets (1).
  if (NEXT_STEP_BETS_ENABLED && planningPolyline && planningPolyline.length >= 2) {
    try {
      const cam = await findCameraOnRoute(planningPolyline, lat, lng);
      if (cam) {
        const camKey = `cam:${cam.lat.toFixed(4)}:${cam.lng.toFixed(4)}`;
        const alreadyEligible = eligible.some((e) => e.type === "next_step" && e.stepKey === camKey);
        if (!fired.nextStep.has(camKey) && !alreadyEligible) {
          eligible.push({
            type: "next_step",
            stepKey: camKey,
            stepLat: cam.lat,
            stepLng: cam.lng,
            maneuverType: "camera",
            maneuverModifier: undefined,
            stepName: undefined,
          });
          console.log(`[tick:detect] next_step camera ${camKey} at (${cam.lat.toFixed(4)},${cam.lng.toFixed(4)})`, { roomId });
        }
      }
    } catch (err) {
      console.warn("[tick:detect] camera query error", err, { roomId });
    }
  }

  // Always provide lat/lng/heading so the filler can attempt a direct OSRM
  // fetch even when the full route planning (computeDriverRouteInstruction) failed.
  const routeCtx: RouteCtx = {
    lat,
    lng,
    heading: driverHeadingDeg,
    planningPolyline,
    osrmSteps: osrmStepsCache,
  };

  return { eligible, routeCtx, scheduler: schedulerNext };
}

// ─── DB helpers ───────────────────────────────────────────────────────────────
//
// FiredKeysSnapshot: load ALL relevant fired-market data for a session in ONE
// DB round-trip instead of 5 separate queries (city_grid, next_turn,
// straight_streak, next_step, zone_exit_time).  detectEligibleTriggers creates
// one snapshot at the start and checks all keys against it synchronously.

type FiredKeysSnapshot = {
  /** cellKeys that already have a city_grid market this session */
  cityGrid: Set<string>;
  /** pinKeys that already have a next_turn market this session */
  nextTurn: Set<string>;
  /** streakKeys that already have a straight_streak market this session */
  straightStreak: Set<string>;
  /** stepKeys that already have a next_step market this session */
  nextStep: Set<string>;
  /** cellKey → set of fired ZoneExitPhases for zone_exit_time markets */
  zonePhases: Map<string, Set<ZoneExitPhase>>;
};

async function loadFiredKeysSnapshot(
  service: Awaited<ReturnType<typeof createServiceClient>>,
  sessionId: string,
): Promise<FiredKeysSnapshot> {
  const snap: FiredKeysSnapshot = {
    cityGrid: new Set(),
    nextTurn: new Set(),
    straightStreak: new Set(),
    nextStep: new Set(),
    zonePhases: new Map(),
  };

  // Single query covering all bet types — replaces 5 separate round-trips.
  // limit(100) is generous: typical sessions have <20 markets per type.
  const { data } = await service
    .from("live_betting_markets")
    .select("id, market_type, subtitle")
    .eq("live_session_id", sessionId)
    .in("market_type", ["city_grid", "next_turn", "straight_streak", "next_step", "zone_exit_time"])
    .order("opens_at", { ascending: false })
    .limit(100);

  const marketIds = (data ?? []).map((row) => (row as { id: string }).id);
  const marketsWithBets = new Set<string>();
  if (marketIds.length > 0) {
    const { data: betRows } = await service
      .from("live_bets")
      .select("market_id")
      .in("market_id", marketIds);
    for (const b of betRows ?? []) {
      marketsWithBets.add((b as { market_id: string }).market_id);
    }
  }

  for (const row of data ?? []) {
    const r = row as { id: string; market_type: string; subtitle: string | null };
    try {
      const meta = JSON.parse(r.subtitle ?? "{}") as Record<string, string | undefined>;
      switch (r.market_type) {
        case "city_grid":
          if (meta.cellKey && marketsWithBets.has(r.id)) snap.cityGrid.add(meta.cellKey);
          break;
        case "next_turn":
          if (meta.pinKey) snap.nextTurn.add(meta.pinKey);
          break;
        case "straight_streak":
          if (meta.streakKey) snap.straightStreak.add(meta.streakKey);
          break;
        case "next_step":
          if (meta.stepKey) snap.nextStep.add(meta.stepKey);
          break;
        case "zone_exit_time":
          if (meta.cellKey && meta.triggerPhase) {
            if (!snap.zonePhases.has(meta.cellKey)) snap.zonePhases.set(meta.cellKey, new Set());
            snap.zonePhases.get(meta.cellKey)!.add(meta.triggerPhase as ZoneExitPhase);
          }
          break;
      }
    } catch {
      // malformed subtitle — ignore
    }
  }
  return snap;
}

// ─── Settlement sweep ─────────────────────────────────────────────────────────

async function sweepPendingSettlements(
  service: Awaited<ReturnType<typeof createServiceClient>>,
  roomId: string,
): Promise<Array<{ marketId: string; reason: string }>> {
  // Fetch both locked AND open zone_exit_time markets so we can lock+settle
  // in one tick when the estimated time has elapsed (avoids a 2-tick round-trip
  // that causes the spinner to hang in dev / low-tick environments).
  const { data: candidates } = await service
    .from("live_betting_markets")
    .select(
      "id, status, opens_at, locks_at, reveal_at, market_type, city_grid_spec, lock_evidence_json, live_session_id, turn_point_lat, turn_point_lng, subtitle",
    )
    .eq("room_id", roomId)
    .in("status", ["locked", "open"])
    .limit(20);

  // Early-settle open engine markets when their resolution condition fires.
  //
  // zone_exit_time → shouldSettleEngineMarket (timer + zone-exit logic).
  //
  // next_step / next_turn / straight_streak → evaluateResolutionConditions.
  //   These markets use the policy-driven evaluator even while open so the bet
  //   resolves immediately when the driver passes the pin — without having to
  //   wait for the 12 s bet-lock window to expire first.  This eliminates the
  //   10-15 s resolution lag that occurred when the vehicle was fast enough to
  //   pass the pin before locks_at.
  const nowMs = Date.now();
  for (const row of candidates ?? []) {
    if ((row as { status: string }).status !== "open") continue;
    const mType = (row as { market_type: string }).market_type;
    if (!isEngineMarketType(mType)) continue;
    const mid = (row as { id: string }).id;
    const sessionId = (row as { live_session_id: string | null }).live_session_id;
    try {
      let shouldSettle = false;

      if (mType === "zone_exit_time") {
        // zone_exit_time has dedicated engine logic (timer + zone exit).
        shouldSettle = await shouldSettleEngineMarket(service, {
          marketId: mid,
          marketType: mType,
          liveSessionId: sessionId,
          roomId,
        });
      } else if (mType === "overtake_30s") {
        shouldSettle = await shouldSettleOvertakeMarket(service, {
          liveSessionId: sessionId,
          opensAt: (row as { opens_at: string }).opens_at,
          revealAt: (row as { reveal_at: string }).reveal_at,
          subtitle: (row as { subtitle: string | null }).subtitle,
        });
      } else {
        // next_step / next_turn / straight_streak: run the same policy evaluator
        // used for locked markets so proximity/heading events fire immediately.
        const sweepRow: MarketSweepRow = {
          id: mid,
          market_type: mType,
          live_session_id: sessionId,
          opens_at: (row as { opens_at: string }).opens_at,
          reveal_at: (row as { reveal_at: string }).reveal_at,
          subtitle: (row as { subtitle: string | null }).subtitle,
          turn_point_lat: (row as { turn_point_lat: number | null }).turn_point_lat,
          turn_point_lng: (row as { turn_point_lng: number | null }).turn_point_lng,
          city_grid_spec: null,
        };
        const { shouldSettle: s, action } = await evaluateResolutionConditions(service, sweepRow, nowMs);
        shouldSettle = s;
        if (shouldSettle && action === "refund") {
          console.log(
            `[tick:sweep] open-market route deviation — refunding ${mid} (${mType})`,
            { roomId },
          );
          await cancelAndRefundMarket(mid, "route_deviation");
          continue;
        }
      }

      if (!shouldSettle) continue;

      console.log(
        `[tick:sweep] open-market early-settle: ${mid} (${mType})`,
        { roomId },
      );
      // Atomic: lock → resolve winner → pay out. Room pointer cleared by payout.
      await lockAndSettleMarket(mid);
    } catch (err) {
      console.error(`[tick:sweep] ERROR in open-market early-settle for ${mid} (${mType}):`, err);
    }
  }

  // Re-fetch only locked markets to settle.
  const { data: locked } = await service
    .from("live_betting_markets")
    .select(
      "id, status, opens_at, locks_at, reveal_at, market_type, city_grid_spec, lock_evidence_json, live_session_id, turn_point_lat, turn_point_lng, subtitle",
    )
    .eq("room_id", roomId)
    .eq("status", "locked")
    .limit(20);

  const notes: Array<{ marketId: string; reason: string }> = [];

  for (const row of locked ?? []) {
    const mid = (row as { id: string }).id;
    const marketType = (row as { market_type: string }).market_type;
    const locksAtStr = (row as { locks_at: string }).locks_at;
    const sessionId = (row as { live_session_id: string | null }).live_session_id;
    const opensAtStr = (row as { opens_at: string }).opens_at;
    const revealAtStr = (row as { reveal_at: string }).reveal_at;

    // ── Per-market error isolation ──────────────────────────────────────────
    // A single failed settlement must NEVER abort the loop for other markets.
    try {
      let settled = false;
      let reason = "pending";

      if (marketType === "zone_exit_time") {
        // zone_exit_time has its own dedicated engine (timer + zone-exit logic)
        // that is intentionally separate from the policy system.
        const settle = await shouldSettleEngineMarket(service, {
          marketId: mid,
          marketType,
          locksAt: locksAtStr,
          liveSessionId: sessionId,
          roomId,
        });
        appendSweepLog(mid, {
          marketType,
          check: "engine_settle",
          result: settle,
          detail: `locksAt=${locksAtStr}`,
        });
        console.log(
          `[tick:sweep] shouldSettleEngineMarket ${mid} (${marketType}) → ${settle}`,
          { roomId, locksAt: locksAtStr },
        );
        if (settle) {
          await revealAndSettleMarket(mid);
          settled = true;
          reason = `engine_${marketType}`;
        }
      } else {
        // All other market types resolve via the policy-driven evaluator.
        // Policies are registered in resolutionPolicies.ts; unknown types
        // fall back to reveal_timeout-only so they always settle eventually.
        const sweepRow: MarketSweepRow = {
          id: mid,
          market_type: marketType,
          live_session_id: sessionId,
          opens_at: opensAtStr,
          reveal_at: revealAtStr,
          subtitle: (row as { subtitle: string | null }).subtitle,
          turn_point_lat: (row as { turn_point_lat: number | null }).turn_point_lat,
          turn_point_lng: (row as { turn_point_lng: number | null }).turn_point_lng,
          city_grid_spec: (row as { city_grid_spec: import("@/lib/live/grid/cityGrid500").CityGridSpecCompact | null }).city_grid_spec,
        };

        const { shouldSettle, firedLabel, action } = await evaluateResolutionConditions(
          service,
          sweepRow,
          nowMs,
        );

        appendSweepLog(mid, {
          marketType,
          check: firedLabel ?? "policy_check",
          result: shouldSettle,
          detail: firedLabel
            ? `condition fired: ${firedLabel}`
            : `opensAt=${opensAtStr}`,
        });

        if (shouldSettle && action === "refund") {
          console.log(
            `[tick:sweep] policy condition "${firedLabel}" — refunding ${mid} (${marketType})`,
          );
          await cancelAndRefundMarket(mid, firedLabel ?? "route_deviation");
          settled = true;
          reason = firedLabel ?? "route_deviation";
        } else if (shouldSettle) {
          console.log(
            `[tick:sweep] policy condition "${firedLabel}" fired — settling ${mid} (${marketType})`,
          );
          await revealAndSettleMarket(mid);
          settled = true;
          reason = firedLabel ?? "policy_settled";
        }
      }

      if (settled) {
        notes.push({ marketId: mid, reason });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendSweepLog(mid, { marketType, check: "error", result: false, detail: msg });
      console.error(`[tick:sweep] ERROR processing ${mid} (${marketType}):`, err);
      // Continue to next market — never let one failure block the rest.
    }
  }

  return notes;
}

async function tryOpenOvertakeFromLeadState(
  service: Awaited<ReturnType<typeof createServiceClient>>,
  roomId: string,
  sessionId: string | null,
): Promise<{ marketId: string; betType: "overtake_30s" } | null> {
  if (!sessionId) return null;
  const { data: lead } = await service
    .from("character_lead_vehicle_state")
    .select(
      "track_id, vehicle_type, confidence, same_direction_confidence, relative_state, prediction_ready",
    )
    .eq("live_session_id", sessionId)
    .maybeSingle();
  if (!lead || !(lead as { track_id?: string | null }).track_id) {
    return null;
  }
  const trackId = (lead as { track_id: string }).track_id;

  const res = await openOvertake30sMarketForRoom(roomId, {
    trackId,
    vehicleType: (lead as { vehicle_type: string | null }).vehicle_type ?? "unknown_vehicle",
    confidence: (lead as { confidence: number | null }).confidence ?? 0,
    sameDirectionConfidence:
      (lead as { same_direction_confidence: number | null }).same_direction_confidence ?? 0,
    relativeState: (lead as { relative_state: string | null }).relative_state ?? "uncertain",
  });
  if ("error" in res) return null;
  return res;
}

