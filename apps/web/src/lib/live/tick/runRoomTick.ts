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
import { lockAndSettleMarket, lockMarket, revealAndSettleMarket } from "@/actions/live-settlement";
import { isEngineMarketType } from "@/lib/live/betting/engineMarketOptions";
import {
  BET_OPEN_WINDOW_MS,
  BET_OPEN_WINDOW_IDLE_MS,
  NEXT_STEP_FILLER_MAX_ROAD_M,
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
import { betSchedulePriority, getFillerEntries } from "@/lib/live/betting/betScheduleConfig";
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
  metersBetween,
  projectOntoPolyline,
  projectPoint,
  roadDistanceAlongPolyline,
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

/** Lock TTL — a tick that crashes without releasing heals after this. */
export const TICK_LOCK_TTL_MS = 5_000;

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
    .select("id, phase, current_market_id, live_session_id")
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

  // ─── 2. Re-read phase + queue ────────────────────────────────────────────
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
    const raw = (queueRow as { queued_triggers: unknown } | null)?.queued_triggers;
    if (Array.isArray(raw)) currentQueue = raw as QueuedTrigger[];
  } catch {
    // queued_triggers not visible yet — proceed with empty queue
  }

  // ─── 3. Detect fresh triggers ────────────────────────────────────────────
  const { eligible: freshTriggers, routeCtx } = await detectEligibleTriggers(
    service,
    roomId,
    sessionId,
    capturedZone,
  );

  if (phaseNow === "market_open") {
    const updatedQueue = buildUpdatedQueue(currentQueue, freshTriggers);
    if (updatedQueue.length !== currentQueue.length) {
      await service
        .from("live_rooms")
        .update({ queued_triggers: updatedQueue })
        .eq("id", roomId);
    }
    return { action: "market_open_queued", queued: updatedQueue.length, settled: settleNotes };
  }

  if (phaseNow === "waiting_for_next_market") {
    const opened = await openFromQueueOrTriggers(service, roomId, currentQueue, freshTriggers);

    // ── Gap-filler ──────────────────────────────────────────────────────────
    // When no context-dependent bet is available, immediately try opening a
    // filler market (next_step with relaxed distance window) so dead-air
    // between bets is kept to a minimum.
    if (opened.action === "no_eligible_bet") {
      const fillerOpened = await tryFillerNextStep(service, roomId, sessionId, routeCtx);
      if (fillerOpened) {
        return { action: fillerOpened.action, ...(fillerOpened.detail ?? {}), settled: settleNotes };
      }
    }

    return { action: opened.action, ...(opened.detail ?? {}), settled: settleNotes };
  }

  if (phaseNow === "market_locked" && marketId) {
    // Check market type before settling.  Engine-driven markets (zone_exit_time)
    // must wait for sweepPendingSettlements / shouldSettleEngineMarket — settling
    // here would fire before the driver has had a chance to exit the zone.
    const { data: lockedMarket } = await service
      .from("live_betting_markets")
      .select("market_type")
      .eq("id", marketId)
      .maybeSingle();
    const lockedType = (lockedMarket as { market_type?: string } | null)?.market_type ?? "";

    if (isEngineMarketType(lockedType)) {
      // Correct state: locked but waiting for engine settlement condition.
      // sweepPendingSettlements will settle this when shouldSettleEngineMarket fires.
      console.log(
        `[tick] engine market ${marketId} (${lockedType}) locked — awaiting sweep`,
        { roomId },
      );
      return { action: "engine_market_locked_awaiting_sweep", marketId, settled: settleNotes };
    }

    // Non-engine: settle immediately (legacy path for next_turn / city_grid stuck in locked).
    const r = await revealAndSettleMarket(marketId);
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
): Promise<{ action: string; detail?: Record<string, unknown> }> {
  const now = Date.now();

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

  // Snapshot the non-expired queued triggers BEFORE clearing so they can be
  // restored if every opener fails. Fresh triggers are always re-detected on
  // the next tick by detectEligibleTriggers, so they don't need restoring.
  const prioritySorted = [...queue]
    .filter((t) => now - t.queuedAt < QUEUE_EXPIRY_MS)
    .sort((a, b) => triggerPriority(a) - triggerPriority(b));
  const savedQueue: QueuedTrigger[] = [...prioritySorted];

  await service.from("live_rooms").update({ queued_triggers: [] }).eq("id", roomId);

  const openerErrors: Array<{ trigger: string; error: string }> = [];

  for (let i = 0; i < prioritySorted.length; i++) {
    const trigger = prioritySorted[i]!;
    // remaining = triggers still waiting after this one opens
    const remaining = prioritySorted.length - 1 - i + fresh.length;
    const res = await openQueuedTrigger(trigger, roomId, remaining);
    if ("marketId" in res && res.marketId) {
      return { action: `opened_${trigger.type}_from_queue`, detail: { marketId: res.marketId, trigger } };
    }
    openerErrors.push({
      trigger: triggerKey(trigger),
      error: (res as { error?: string }).error ?? "unknown",
    });
  }

  const freshSorted = [...fresh].sort((a, b) => freshPriority(a) - freshPriority(b));
  for (let i = 0; i < freshSorted.length; i++) {
    const ft = freshSorted[i]!;
    const remaining = freshSorted.length - 1 - i;
    const res = await openFreshTrigger(ft, roomId, remaining);
    if ("marketId" in res && res.marketId) {
      return { action: `opened_${ft.type}`, detail: { marketId: res.marketId } };
    }
    openerErrors.push({
      trigger: freshTriggerKey(ft),
      error: (res as { error?: string }).error ?? "unknown",
    });
  }

  // Every opener failed — put the saved queued triggers back so they are
  // retried on the next tick rather than being silently dropped.
  if (openerErrors.length > 0 && savedQueue.length > 0) {
    console.warn("[tick] all openers failed — restoring queue", JSON.stringify(openerErrors));
    await service
      .from("live_rooms")
      .update({ queued_triggers: savedQueue })
      .eq("id", roomId);
  } else if (openerErrors.length > 0) {
    console.warn("[tick] all openers failed (no queue to restore)", JSON.stringify(openerErrors));
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
  if (t.type === "zone_exit_time") {
    const phases: ZoneExitPhase[] = ["entry", "center_70m", "exit_outer"];
    return base + phases.indexOf(t.phase as ZoneExitPhase) * 0.1;
  }
  return base;
}

function freshPriority(t: FreshTrigger): number {
  const mType = t.type === "next_zone" ? "city_grid" : t.type;
  const base = betSchedulePriority(mType);
  if (t.type === "zone_exit_time") {
    const phases: ZoneExitPhase[] = ["entry", "center_70m", "exit_outer"];
    return base + phases.indexOf(t.phase as ZoneExitPhase) * 0.1;
  }
  return base;
}

/**
 * Compute the bet window for this open event.
 * Rule: at least BET_OPEN_WINDOW_MS (8 s), up to BET_OPEN_WINDOW_IDLE_MS (12 s)
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
): Promise<{ action: string; detail?: Record<string, unknown> } | null> {
  if (!NEXT_STEP_BETS_ENABLED) return null;
  if (!routeCtx) return null;

  const fillerEntry = getFillerEntries().find((e) => e.marketType === "next_step");
  if (!fillerEntry) return null;

  const minM = fillerEntry.fillerMinM ?? NEXT_STEP_MIN_ROAD_M;
  const maxM = fillerEntry.fillerMaxM ?? NEXT_STEP_FILLER_MAX_ROAD_M;

  let steps = routeCtx.osrmSteps;
  let polylineForCheck = routeCtx.planningPolyline;

  // ── Fallback: fetch OSRM steps when the normal detection path didn't ──────
  //
  // Two sub-cases:
  //   A) planningPolyline available but steps = null (computeDriverRouteInstruction
  //      succeeded but OSRM step fetch was skipped due to a feature-flag or error).
  //      → Route to planPolyEnd so the on-route check can still run.
  //   B) planningPolyline = null (full route planning failed, e.g. Overpass down).
  //      → Project a forward probe using GPS heading.  If heading is also null
  //        (driver stopped) skip the on-route check but still try OSRM.
  if (!steps) {
    const { heading, lat, lng } = routeCtx;
    let forwardTarget: import("@/lib/live/routing/geometry").LatLng;
    let keepPolylineCheck = false;

    if (polylineForCheck && polylineForCheck.length >= 2) {
      // Sub-case A: planning polyline is known → route to its end point.
      forwardTarget = polylineForCheck[polylineForCheck.length - 1]!;
      keepPolylineCheck = true;
    } else if (heading != null) {
      // Sub-case B: no polyline → forward probe in heading direction.
      forwardTarget = projectPoint({ lat, lng }, heading, FILLER_FORWARD_PROBE_M);
    } else {
      // No polyline and no heading → can't project a target; bail out.
      console.log(`[tick:filler] next_step: no steps, no polyline, no heading — skipping`, { roomId });
      return null;
    }

    try {
      const osrmResult = await fetchOsrmDrivingRouteWithSteps({ lat, lng }, forwardTarget);
      if (!osrmResult) return null;
      steps = osrmResult.steps;
      // If we used the planning polyline as the OSRM target, keep the polyline
      // for the on-route check.  Otherwise clear it so the check is skipped.
      if (!keepPolylineCheck) polylineForCheck = null;
      console.log(
        `[tick:filler] next_step: fetched ${steps.length} OSRM steps via ${keepPolylineCheck ? "planPoly" : "forward-probe"} fallback`,
        { roomId },
      );
    } catch (err) {
      console.error(`[tick:filler] next_step: fallback OSRM fetch failed`, err, { roomId });
      return null;
    }
  }

  const candidates = findNextStepCandidates(
    steps,
    polylineForCheck,
    routeCtx.lat,
    routeCtx.lng,
    minM,
    maxM,
  );

  for (const candidate of candidates) {
    const fired = await hasFiredNextStep(service, sessionId, candidate.stepKey);
    if (fired) {
      console.log(`[tick:filler] next_step: ${candidate.stepKey} already fired — trying next`, { roomId });
      continue;
    }

    console.log(
      `[tick:filler] next_step: ${candidate.stepKey} (${candidate.maneuverType} ${candidate.maneuverModifier ?? ""}) road dist ${Math.round(candidate.roadMeters)}m window [${minM},${maxM}]m`,
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
      return { action: "opened_next_step_filler", detail: { marketId: res.marketId } };
    }

    console.warn(`[tick:filler] next_step opener failed for ${candidate.stepKey}`, res, { roomId });
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
  planningPolyline: import("@/lib/live/routing/geometry").LatLng[] | null;
  /** OSRM step list fetched for the same segment.  Null when unavailable. */
  osrmSteps: OsrmStep[] | null;
};

type DetectResult = {
  eligible: FreshTrigger[];
  /**
   * Route context that the filler path can reuse without re-fetching.
   * Always non-null when GPS is available — planningPolyline/osrmSteps
   * may still be null when the route calculation failed.
   */
  routeCtx: RouteCtx | null;
};

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
  planningPolyline: import("@/lib/live/routing/geometry").LatLng[] | null,
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

// ─── Dense intersection extraction (for straight_streak) ─────────────────────

/**
 * Extract every real road junction from OSRM step intersection data.
 *
 * Each OSRM step includes an `intersections` array covering ALL road junctions
 * along the step path — not just the final maneuver point.  This gives a dense,
 * accurate list of every crossroad the driver will cross, far more granular than
 * the sparse 3-pin OSM queue used by computeDriverRouteInstruction.
 *
 * Filter: bearings.length ≥ 3 = real side-road junction (T or 4-way).
 *         bearings.length = 2 = simple road continuation (bend, name change).
 *
 * Returns junctions in ascending distance order from the vehicle, limited to
 * the range [minM, maxM].
 */
function extractDenseIntersections(
  steps: OsrmStep[],
  vehicleLat: number,
  vehicleLng: number,
  minM = 0,
  maxM = 1500,
): import("@/lib/live/routing/straightStreakAnalyzer").CrossroadBearing[] {
  const vehicle = { lat: vehicleLat, lng: vehicleLng };
  const seen = new Set<string>();
  const results: import("@/lib/live/routing/straightStreakAnalyzer").CrossroadBearing[] = [];

  for (const step of steps) {
    for (const ix of step.intersections) {
      // Skip trivial continuations — real crossroads have ≥3 road branches.
      if (ix.bearings.length < 3) continue;

      const { lat, lng } = ix.location;
      // Deduplicate by snapped coordinate (OSRM can repeat junction positions
      // across adjacent steps due to micro-rounding).
      const key = `${lat.toFixed(5)}:${lng.toFixed(5)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const distanceMeters = metersBetween(vehicle, { lat, lng });
      if (distanceMeters < minM || distanceMeters > maxM) continue;

      // Synthetic nodeId from coordinate hash for dedup in the tracker.
      const nodeId =
        (Math.round(lat * 1e4) & 0xffff) * 65536 +
        (Math.round(Math.abs(lng) * 1e4) & 0xffff);

      results.push({
        nodeId,
        lat,
        lng,
        distanceMeters,
        // bearingChangeDeg/isStraight are irrelevant here — the resolver
        // scores each junction from actual GPS headings at settlement time.
        bearingChangeDeg: 0,
        isStraight: true,
      });
    }
  }

  return results.sort((a, b) => a.distanceMeters - b.distanceMeters);
}

// ─── Trigger detection ────────────────────────────────────────────────────────

async function detectEligibleTriggers(
  service: Awaited<ReturnType<typeof createServiceClient>>,
  roomId: string,
  sessionId: string,
  capturedZone: string | null,
): Promise<DetectResult> {
  const eligible: FreshTrigger[] = [];

  const { data: gpsRow } = await service
    .from("live_route_snapshots")
    .select("normalized_lat,normalized_lng,raw_lat,raw_lng,heading_deg")
    .eq("live_session_id", sessionId)
    .order("recorded_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!gpsRow) return { eligible, routeCtx: null }; // no position — filler can't run either
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

        // Fire next_zone whenever the driver is anywhere inside the cell
        // (same entry condition as zone_exit_time "entry").  The old 100 m
        // center gate blocked most routes because road paths rarely pass
        // within 100 m of a 500 m cell centre.  The opener still verifies
        // the driver is within bounds at open time.
        {
          const fired = await hasFiredCityGrid(service, sessionId, cellKey);
          if (!fired) eligible.push({ type: "next_zone", cellKey });
        }

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
            const fired = await hasFiredNextTurn(service, sessionId, pinKey);
            if (!fired) {
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
          const fired = await hasFiredStraightStreak(service, sessionId, analysis.streakKey);
          if (!fired) {
            eligible.push({
              type: "straight_streak",
              streakKey: analysis.streakKey,
              // Carry the analysis so the opener can use it directly without
              // re-running computeDriverRouteInstruction on a potentially
              // different ROOM_STATE snapshot.
              // NOTE: crossroads will be replaced with denser OSRM junction
              // data below once osrmStepsCache is populated.
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
  let osrmTarget: import("@/lib/live/routing/geometry").LatLng | null = null;
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

        // Augment any straight_streak trigger with dense OSRM junction data.
        // The sparse OSM pin queue (computeDriverRouteInstruction) only keeps
        // 3 pins at a time, severely limiting how many crossroads the tracker
        // can count.  OSRM step intersections give us every real junction
        // (bearings.length ≥ 3) along the full planned route — typically
        // 10–30+ crossroads — so the tracker can count them all.
        const streakTrigger = eligible.find((t) => t.type === "straight_streak");
        if (streakTrigger) {
          const denseJunctions = extractDenseIntersections(osrmResult.steps, lat, lng);
          if (denseJunctions.length > 0) {
            const sparsePinCount = streakTrigger.crossroads?.length ?? 0;
            streakTrigger.crossroads = denseJunctions;
            console.log(
              `[tick:detect] straight_streak: augmented with ${denseJunctions.length} dense OSRM junctions (was ${sparsePinCount} sparse pins)`,
              { roomId },
            );
          }
        }

        // Normal trigger window — only the nearest unfired step.
        // Use osrmPolylineCheck (null when forward probe was used) so the
        // on-route check is skipped when no reference polyline is available.
        const candidates = findNextStepCandidates(
          osrmResult.steps,
          osrmPolylineCheck,
          lat,
          lng,
          NEXT_STEP_MIN_ROAD_M,
          NEXT_STEP_MAX_ROAD_M,
        );
        for (const c of candidates) {
          const fired = await hasFiredNextStep(service, sessionId, c.stepKey);
          if (!fired) {
            console.log(
              `[tick:detect] next_step: ${c.stepKey} (${c.maneuverType} ${c.maneuverModifier ?? ""}) road dist ${Math.round(c.roadMeters)}m in [${NEXT_STEP_MIN_ROAD_M},${NEXT_STEP_MAX_ROAD_M}]m`,
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

  // Always provide lat/lng/heading so the filler can attempt a direct OSRM
  // fetch even when the full route planning (computeDriverRouteInstruction) failed.
  const routeCtx: RouteCtx = {
    lat,
    lng,
    heading: driverHeadingDeg,
    planningPolyline,
    osrmSteps: osrmStepsCache,
  };

  return { eligible, routeCtx };
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

async function hasFiredCityGrid(
  service: Awaited<ReturnType<typeof createServiceClient>>,
  sessionId: string,
  cellKey: string,
): Promise<boolean> {
  const { data } = await service
    .from("live_betting_markets")
    .select("subtitle")
    .eq("live_session_id", sessionId)
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
  sessionId: string,
  pinKey: string,
): Promise<boolean> {
  const { data } = await service
    .from("live_betting_markets")
    .select("subtitle")
    .eq("live_session_id", sessionId)
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

async function hasFiredStraightStreak(
  service: Awaited<ReturnType<typeof createServiceClient>>,
  sessionId: string,
  streakKey: string,
): Promise<boolean> {
  const { data } = await service
    .from("live_betting_markets")
    .select("subtitle")
    .eq("live_session_id", sessionId)
    .eq("market_type", "straight_streak")
    .order("opens_at", { ascending: false })
    .limit(20);
  return (data ?? []).some((row) => {
    try {
      const meta = JSON.parse(
        (row as { subtitle: string | null }).subtitle ?? "{}",
      ) as { streakKey?: string };
      return meta.streakKey === streakKey;
    } catch {
      return false;
    }
  });
}

async function hasFiredNextStep(
  service: Awaited<ReturnType<typeof createServiceClient>>,
  sessionId: string,
  stepKey: string,
): Promise<boolean> {
  const { data } = await service
    .from("live_betting_markets")
    .select("subtitle")
    .eq("live_session_id", sessionId)
    .eq("market_type", "next_step")
    .order("opens_at", { ascending: false })
    .limit(20);
  return (data ?? []).some((row) => {
    try {
      const meta = JSON.parse(
        (row as { subtitle: string | null }).subtitle ?? "{}",
      ) as { stepKey?: string };
      return meta.stepKey === stepKey;
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
      const meta = JSON.parse((row as { subtitle: string | null }).subtitle ?? "{}") as {
        cellKey?: string;
        triggerPhase?: string;
      };
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

  // Lock-and-settle any open engine markets whose estimated countdown has elapsed.
  // Uses lockAndSettleMarket so the room pointer stays set throughout payout.
  const nowMs = Date.now();
  for (const row of candidates ?? []) {
    if ((row as { status: string }).status !== "open") continue;
    const mType = (row as { market_type: string }).market_type;
    if (!isEngineMarketType(mType)) continue;
    const mid = (row as { id: string }).id;
    const sessionId = (row as { live_session_id: string | null }).live_session_id;
    try {
      const shouldSettle = await shouldSettleEngineMarket(service, {
        marketId: mid,
        marketType: mType,
        liveSessionId: sessionId,
        roomId,
      });
      if (!shouldSettle) continue;
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

        const { shouldSettle, firedLabel } = await evaluateResolutionConditions(
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

        if (shouldSettle) {
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

