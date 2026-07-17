import {
  NEXT_STEP_MIN_ROAD_M,
  NEXT_STEP_FILLER_MAX_ROAD_M,
} from "@/lib/live/betting/betWindowConstants";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SINGLE SOURCE OF TRUTH — live bet scheduling
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   • Spatial trigger thresholds  → betWindowConstants.ts (distances, windows)
 *   • Priority, slots, spacing,   → this file
 *     dwell, concurrency
 *   • Per-room dwell / last-open  → betSchedulerState.ts (persisted jsonb)
 *
 * The tick loop calls `evaluateBetOpen()` before every open — nowhere else.
 */

// ─── Global open rules ───────────────────────────────────────────────────────

export const BET_SCHEDULE_RULES = {
  /** Min ms between opening any two bet popups. */
  minGapBetweenOpensMs: 5_000,
  /** ONE bet at a time — viewers must be able to track a single thing. */
  maxBettingPopups: 1,
} as const;

// ─── Trigger ↔ market mapping ────────────────────────────────────────────────

export type BetPopupSlot = "main" | "step";

export type BetTriggerType =
  | "zone_exit_time"
  | "next_zone"
  | "next_step"
  | "next_turn"
  | "straight_streak";

export type BetOpenBlockCode =
  | "MIN_GAP"
  | "BETTING_POPUP_LIMIT"
  | "CELL_DWELL"
  | "ANY_BETTING_ACTIVE"
  | "MAIN_BETTING_ACTIVE"
  | "INCOMPATIBLE_MAIN"
  | "STEP_SLOT_BUSY";

export type BetScheduleTriggerEntry = {
  triggerType: BetTriggerType;
  marketType: string;
  slot: BetPopupSlot;
  priority: number;
  isFiller: boolean;
  fillerMinM?: number;
  fillerMaxM?: number;
  description: string;
  /** Ms driver must stay in the current grid cell before this trigger is eligible. */
  cellDwellMs?: number;
  /** Block while any slot is still accepting bets (market_open / open step). */
  deferWhileAnyBetting?: boolean;
  /** Block while the main slot is accepting bets. */
  deferWhileMainBetting?: boolean;
  /**
   * Block while main is accepting bets AND its market type is in this list.
   * Used to prevent zone-exit + time-to-pin overlap without blocking everything.
   */
  incompatibleMainTypesWhileBetting?: string[];
};

export const BET_SCHEDULE: BetScheduleTriggerEntry[] = [
  {
    triggerType: "zone_exit_time",
    marketType: "zone_exit_time",
    slot: "main",
    priority: 1,
    isFiller: false,
    description:
      "Time in zone — fires on cell entry, ≤70 m from centre, and outer exit. Up to 3× per cell.",
  },
  {
    triggerType: "next_turn",
    marketType: "next_turn",
    slot: "main",
    priority: 2,
    isFiller: false,
    description: "Turn direction at next crossroad pin (100–220 m ahead).",
  },
  {
    triggerType: "next_step",
    marketType: "next_step",
    slot: "step",
    priority: 3,
    isFiller: true,
    fillerMinM: NEXT_STEP_MIN_ROAD_M,
    fillerMaxM: NEXT_STEP_FILLER_MAX_ROAD_M,
    incompatibleMainTypesWhileBetting: ["zone_exit_time"],
    description:
      "Time to pin — step slot. Blocked only while a zone-exit main bet is open; " +
      "can open during other main bets or after zone exit locks.",
  },
  {
    triggerType: "straight_streak",
    marketType: "straight_streak",
    slot: "main",
    priority: 4,
    isFiller: false,
    description: "Straight crossroads ahead on the planned route (≥2).",
  },
  {
    triggerType: "next_zone",
    marketType: "city_grid",
    slot: "main",
    priority: 5,
    isFiller: false,
    cellDwellMs: 12_000,
    deferWhileAnyBetting: true,
    description:
      "Pick next grid square — once per cell, 12 s after entering, when no bet popup is open.",
  },
];

const TRIGGER_BY_TYPE = Object.fromEntries(
  BET_SCHEDULE.map((e) => [e.triggerType, e]),
) as Record<BetTriggerType, BetScheduleTriggerEntry>;

// ─── Open evaluation ─────────────────────────────────────────────────────────

export type BetOpenContext = {
  nowMs: number;
  lastBetOpenedAtMs: number | null;
  cellDwell: { cellKey: string; enteredAtMs: number } | null;
  mainSlot: {
    phase: string;
    marketId: string | null;
    marketType: string | null;
    /** True when main slot is in market_open (viewers can bet). */
    bettingOpen: boolean;
  };
  stepSlot: {
    marketId: string | null;
    /** True when step market status is open. */
    bettingOpen: boolean;
  };
  /**
   * One-bet-at-a-time gate (any unsettled market of any type, and time since
   * the previous market closed). When present it takes precedence over the
   * slot-based popup accounting.
   */
  singleGate?: {
    activeMarketId: string | null;
    msSinceLastClose: number | null;
  };
};

export type BetOpenEvaluation = {
  allowed: boolean;
  code?: BetOpenBlockCode;
  retryAfterMs?: number;
};

export function scheduleEntryForTrigger(
  triggerType: BetTriggerType,
): BetScheduleTriggerEntry {
  return TRIGGER_BY_TYPE[triggerType];
}

export function scheduleEntryForMarket(marketType: string): BetScheduleTriggerEntry | undefined {
  return BET_SCHEDULE.find((e) => e.marketType === marketType);
}

/** Priority for queue ordering. Zone-exit sub-phases add fractional offsets at call-site. */
export function betSchedulePriority(marketType: string): number {
  return scheduleEntryForMarket(marketType)?.priority ?? 99;
}

export function getFillerEntries(): BetScheduleTriggerEntry[] {
  return BET_SCHEDULE.filter((e) => e.isFiller).sort((a, b) => a.priority - b.priority);
}

export function triggerCellDwellMs(triggerType: BetTriggerType): number | undefined {
  return TRIGGER_BY_TYPE[triggerType]?.cellDwellMs;
}

function activeBettingPopupCount(ctx: BetOpenContext): number {
  let n = 0;
  if (ctx.mainSlot.bettingOpen) n += 1;
  if (ctx.stepSlot.bettingOpen) n += 1;
  return n;
}

/** New bets must wait this long after the previous bet closed. */
export const MIN_GAP_AFTER_CLOSE_MS = 10_000;

export function evaluateBetOpen(
  triggerType: BetTriggerType,
  ctx: BetOpenContext,
): BetOpenEvaluation {
  const rule = TRIGGER_BY_TYPE[triggerType];
  const sinceLast =
    ctx.lastBetOpenedAtMs != null ? ctx.nowMs - ctx.lastBetOpenedAtMs : null;

  if (
    sinceLast != null &&
    sinceLast < BET_SCHEDULE_RULES.minGapBetweenOpensMs
  ) {
    return {
      allowed: false,
      code: "MIN_GAP",
      retryAfterMs: BET_SCHEDULE_RULES.minGapBetweenOpensMs - sinceLast,
    };
  }

  // One bet at a time, 10s of air after the previous one closes — viewers
  // must always be able to tell what they are betting on.
  if (ctx.singleGate) {
    if (ctx.singleGate.activeMarketId) {
      return { allowed: false, code: "ANY_BETTING_ACTIVE" };
    }
    if (
      ctx.singleGate.msSinceLastClose != null &&
      ctx.singleGate.msSinceLastClose < MIN_GAP_AFTER_CLOSE_MS
    ) {
      return {
        allowed: false,
        code: "MIN_GAP",
        retryAfterMs:
          MIN_GAP_AFTER_CLOSE_MS - ctx.singleGate.msSinceLastClose,
      };
    }
  }

  if (rule.cellDwellMs != null) {
    const dwell = ctx.cellDwell;
    if (!dwell) {
      return { allowed: false, code: "CELL_DWELL" };
    }
    const elapsed = ctx.nowMs - dwell.enteredAtMs;
    if (elapsed < rule.cellDwellMs) {
      return {
        allowed: false,
        code: "CELL_DWELL",
        retryAfterMs: rule.cellDwellMs - elapsed,
      };
    }
  }

  const mainBetting = ctx.mainSlot.bettingOpen;
  const stepBetting = ctx.stepSlot.bettingOpen;
  const anyBetting = mainBetting || stepBetting;

  if (rule.deferWhileAnyBetting && anyBetting) {
    return { allowed: false, code: "ANY_BETTING_ACTIVE" };
  }

  if (rule.deferWhileMainBetting && mainBetting) {
    return { allowed: false, code: "MAIN_BETTING_ACTIVE" };
  }

  if (
    rule.incompatibleMainTypesWhileBetting?.length &&
    mainBetting &&
    ctx.mainSlot.marketType &&
    rule.incompatibleMainTypesWhileBetting.includes(ctx.mainSlot.marketType)
  ) {
    return { allowed: false, code: "INCOMPATIBLE_MAIN" };
  }

  if (activeBettingPopupCount(ctx) >= BET_SCHEDULE_RULES.maxBettingPopups) {
    return { allowed: false, code: "BETTING_POPUP_LIMIT" };
  }

  return { allowed: true };
}
