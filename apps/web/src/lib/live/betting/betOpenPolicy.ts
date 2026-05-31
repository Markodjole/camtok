/**
 * Central bet-popup scheduling policy.
 *
 * All spacing, dwell, slot, and concurrency rules live here.  The tick loop
 * and trigger detector consult `evaluateBetOpen()` — never ad-hoc ifs.
 */

export type BetPopupSlot = "main" | "step";

export type BetTriggerType =
  | "zone_exit_time"
  | "next_zone"
  | "next_step"
  | "next_turn"
  | "straight_streak";

export type BetOpenBlockCode =
  | "MIN_GAP"
  | "POPUP_LIMIT"
  | "CELL_DWELL"
  | "REQUIRES_IDLE"
  | "MAIN_SLOT_BUSY"
  | "STEP_SLOT_BUSY";

export type BetTriggerPolicy = {
  slot: BetPopupSlot;
  /** live_betting_markets.market_type opened by this trigger. */
  marketType: string;
  /** Minimum time (ms) driver must remain in the current grid cell before eligible. */
  cellDwellMs?: number;
  /** Only open when no bet popup is on screen (main or step). */
  requiresNoActivePopup?: boolean;
};

export const BET_OPEN_POLICY: {
  minGapBetweenOpensMs: number;
  maxSimultaneousPopups: number;
  triggers: Record<BetTriggerType, BetTriggerPolicy>;
} = {
  /**
   * Never open a new popup within this many ms of the previous one opening.
   * Applies to all trigger types and both slots.
   */
  minGapBetweenOpensMs: 5_000,

  /**
   * Maximum bet popups on screen at once (main + step combined).
   * Set to 1 to prevent zone-exit + time-to-pin overlap.
   */
  maxSimultaneousPopups: 1,

  triggers: {
    zone_exit_time: {
      slot: "main",
      marketType: "zone_exit_time",
    },
    next_zone: {
      slot: "main",
      marketType: "city_grid",
      cellDwellMs: 12_000,
      requiresNoActivePopup: true,
    },
    next_step: {
      slot: "step",
      marketType: "next_step",
      requiresNoActivePopup: true,
    },
    next_turn: {
      slot: "main",
      marketType: "next_turn",
    },
    straight_streak: {
      slot: "main",
      marketType: "straight_streak",
    },
  },
};

export type BetOpenContext = {
  nowMs: number;
  lastBetOpenedAtMs: number | null;
  cellDwell: { cellKey: string; enteredAtMs: number } | null;
  mainSlot: {
    phase: string;
    marketId: string | null;
    marketType: string | null;
  };
  stepSlot: {
    marketId: string | null;
  };
};

export type BetOpenEvaluation = {
  allowed: boolean;
  code?: BetOpenBlockCode;
  /** Ms until this trigger may be retried (when blocked). */
  retryAfterMs?: number;
};

export function triggerPolicy(type: BetTriggerType): BetTriggerPolicy {
  return BET_OPEN_POLICY.triggers[type];
}

export function triggerMarketType(type: BetTriggerType): string {
  return BET_OPEN_POLICY.triggers[type].marketType;
}

export function triggerSlot(type: BetTriggerType): BetPopupSlot {
  return BET_OPEN_POLICY.triggers[type].slot;
}

export function activePopupCount(ctx: BetOpenContext): number {
  let count = 0;
  if (
    ctx.mainSlot.marketId &&
    (ctx.mainSlot.phase === "market_open" || ctx.mainSlot.phase === "market_locked")
  ) {
    count += 1;
  }
  if (ctx.stepSlot.marketId) count += 1;
  return count;
}

export function msSinceLastBetOpen(ctx: BetOpenContext): number | null {
  if (ctx.lastBetOpenedAtMs == null) return null;
  return ctx.nowMs - ctx.lastBetOpenedAtMs;
}

/** True when any viewer-visible bet popup occupies the screen. */
export function isAnyBetPopupActive(ctx: BetOpenContext): boolean {
  return activePopupCount(ctx) > 0;
}

export function evaluateBetOpen(
  triggerType: BetTriggerType,
  ctx: BetOpenContext,
): BetOpenEvaluation {
  const rule = BET_OPEN_POLICY.triggers[triggerType];

  const sinceLast = msSinceLastBetOpen(ctx);
  if (
    sinceLast != null &&
    sinceLast < BET_OPEN_POLICY.minGapBetweenOpensMs
  ) {
    return {
      allowed: false,
      code: "MIN_GAP",
      retryAfterMs: BET_OPEN_POLICY.minGapBetweenOpensMs - sinceLast,
    };
  }

  if (activePopupCount(ctx) >= BET_OPEN_POLICY.maxSimultaneousPopups) {
    return { allowed: false, code: "POPUP_LIMIT" };
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

  if (rule.requiresNoActivePopup === true && isAnyBetPopupActive(ctx)) {
    return { allowed: false, code: "REQUIRES_IDLE" };
  }

  if (
    rule.slot === "step" &&
    ctx.mainSlot.marketId &&
    (ctx.mainSlot.phase === "market_open" || ctx.mainSlot.phase === "market_locked")
  ) {
    return { allowed: false, code: "MAIN_SLOT_BUSY" };
  }

  if (rule.slot === "main" && ctx.stepSlot.marketId) {
    return { allowed: false, code: "STEP_SLOT_BUSY" };
  }

  return { allowed: true };
}

export function filterTriggersByPolicy<T extends { type: BetTriggerType }>(
  triggers: T[],
  ctx: BetOpenContext,
): T[] {
  return triggers.filter((t) => evaluateBetOpen(t.type, ctx).allowed);
}
