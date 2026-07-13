/**
 * Resolution policy framework for live betting markets.
 *
 * # Concepts
 *
 * A **ResolutionEvent** is a named, typed trigger that can fire during the
 * settlement sweep.  Each event type carries its own configuration params.
 *
 * A **ResolutionCondition** wraps one event with a human-readable `label`
 * used for sweep logs and as the returned `reason` string when it fires.
 *
 * A **MarketResolutionPolicy** is an ordered list of conditions for one
 * market type.  The sweep evaluates conditions in declaration order and
 * settles the market as soon as the FIRST condition fires — whichever
 * comes first wins.
 *
 * # Adding a new market type
 * 1. Define its event shape (if the existing union doesn't cover it).
 * 2. Call `registerResolutionPolicy({ marketType, description, conditions })`.
 * 3. The evaluator in `resolutionEvaluator.ts` dispatches automatically.
 *
 * # Policy contract
 * - Every policy MUST end with a `reveal_timeout` condition so the market
 *   is guaranteed to settle eventually, even if all other conditions fail.
 * - Conditions are evaluated in order — put the most specific / cheapest
 *   checks first so GPS queries are only made when necessary.
 */

import {
  NEXT_STEP_APPROACH_M,
  NEXT_STEP_DEPARTURE_M,
  NEXT_STEP_ROUTE_DEVIATION_M,
  STRAIGHT_STREAK_COMMITTED_TURN_DEG,
  STRAIGHT_STREAK_INTERSECTIONS_TO_RESOLVE,
} from "./betWindowConstants";

// ─── Event type definitions ────────────────────────────────────────────────

/**
 * Fires when the driver's heading (first→last GPS since opens_at) has changed
 * by at least `thresholdDeg` degrees.
 *
 * Use this to detect that the driver has committed to a genuine turn.
 * Prefer larger thresholds (≥ 40°) to avoid triggering on GPS jitter.
 */
export type HeadingChangeEvent = {
  type: "heading_change";
  /** Minimum absolute heading delta (degrees) to fire. */
  thresholdDeg: number;
};

/**
 * Fires when the driver has physically passed through at least `count`
 * intersections from the ordered list stored in the market subtitle.
 *
 * "Passed" means at least one GPS snapshot was found within
 * STREAK_CROSSROAD_PROXIMITY_M of the intersection centroid.
 *
 * The effective threshold is `min(count, intersections.length)` so it
 * never waits for more crossroads than the market was opened with.
 *
 * Use this as a progress-based resolution cap so markets don't hang
 * waiting for reveal_timeout when the driver goes dead-straight.
 */
export type IntersectionsPassedEvent = {
  type: "intersections_passed";
  /** Resolve after the driver has passed this many intersections. */
  count: number;
};

/**
 * Fires unconditionally when `nowMs >= new Date(market.reveal_at).getTime()`.
 *
 * Must always be the LAST condition in every policy — it is the guarantee
 * that a market eventually settles even if all earlier conditions fail.
 */
export type RevealTimeoutEvent = {
  type: "reveal_timeout";
};

/**
 * Fires when the driver's current grid cell differs from the starting cell
 * recorded in the market subtitle at open time.
 *
 * Used by `city_grid` markets (even though those typically settle at
 * locks_at — this condition acts as a sweep fallback for stuck markets).
 */
export type CellCrossedEvent = {
  type: "cell_crossed";
};

/**
 * Fires when the driver leaves the planned path to the pin (perpendicular
 * distance > `maxOffRouteM`) before reaching the pin approach zone.
 *
 * Used by `next_step` markets — triggers a refund, not a winner settlement.
 */
export type RouteDeviationEvent = {
  type: "route_deviation";
  /** Max perpendicular distance (m) from the stored driver→pin polyline. */
  maxOffRouteM: number;
};

/**
 * Fires when the driver has:
 *   (a) approached within `approachRadiusM` of the turn pin, AND
 *   (b) the latest GPS point is at least `departureM` further away
 *       (confirming the driver has passed the pin and is moving away).
 *
 * Also fires early if the overall heading change since opens_at exceeds
 * `headingFallbackDeg` — a separate guard for when the driver turns well
 * before reaching the pin.
 *
 * Used by `next_turn` and `next_step` markets.
 */
export type TurnPinProximityEvent = {
  type: "turn_pin_proximity";
  /** Driver must come within this radius (meters) of the pin. */
  approachRadiusM: number;
  /** Distance (meters) past the closest point to confirm departure. */
  departureM: number;
  /**
   * Heading-change fallback (degrees, first→last GPS since opens_at).
   * Fires immediately when this threshold is exceeded, even if the driver
   * hasn't yet reached the pin proximity zone.
   */
  headingFallbackDeg: number;
};

// ─── Union ─────────────────────────────────────────────────────────────────

export type ResolutionEvent =
  | HeadingChangeEvent
  | IntersectionsPassedEvent
  | RevealTimeoutEvent
  | CellCrossedEvent
  | RouteDeviationEvent
  | TurnPinProximityEvent;

// ─── Condition & Policy types ──────────────────────────────────────────────

/**
 * One named condition inside a resolution policy.
 *
 * `label` is used for sweep-log entries and returned as the settlement
 * `reason` string when the condition fires — use short snake_case identifiers
 * so they read well in logs (e.g. "driver_turned", "intersections_passed").
 */
export type ResolutionCondition = {
  label: string;
  event: ResolutionEvent;
};

/**
 * Ordered list of resolution conditions for one market type.
 *
 * The sweep evaluates conditions in declaration order.  The FIRST condition
 * that fires triggers settlement.  The last condition MUST be `reveal_timeout`
 * to guarantee eventual settlement.
 */
export type MarketResolutionPolicy = {
  marketType: string;
  /** Human-readable description for documentation and debug output. */
  description: string;
  conditions: ResolutionCondition[];
};

// ─── Registry ──────────────────────────────────────────────────────────────

const _registry = new Map<string, MarketResolutionPolicy>();

/**
 * Register or overwrite the resolution policy for a market type.
 *
 * Call at module load time; the evaluator reads the registry lazily so
 * late registrations (e.g. feature-flagged types) still take effect.
 */
export function registerResolutionPolicy(policy: MarketResolutionPolicy): void {
  _registry.set(policy.marketType, policy);
}

/**
 * Return the resolution policy for the given market type.
 * Returns `null` when no policy has been registered for this type.
 */
export function getResolutionPolicy(marketType: string): MarketResolutionPolicy | null {
  return _registry.get(marketType) ?? null;
}

// ─── Built-in policies ─────────────────────────────────────────────────────
//
// Registered in order of most-specific to most-general.
// zone_exit_time is intentionally absent — it is handled by
// shouldSettleEngineMarket (timer + zone-exit logic) rather than this system.

registerResolutionPolicy({
  marketType: "straight_streak",
  description:
    "Settle when the driver takes a clear turn (heading change ≥ " +
    `${STRAIGHT_STREAK_COMMITTED_TURN_DEG}°) OR after passing ` +
    `${STRAIGHT_STREAK_INTERSECTIONS_TO_RESOLVE} intersections — whichever ` +
    "comes first. reveal_at is the unconditional safety cap.",
  conditions: [
    {
      label: "driver_turned",
      event: {
        type: "heading_change",
        thresholdDeg: STRAIGHT_STREAK_COMMITTED_TURN_DEG,
      },
    },
    {
      label: "intersections_passed",
      event: {
        type: "intersections_passed",
        count: STRAIGHT_STREAK_INTERSECTIONS_TO_RESOLVE,
      },
    },
    {
      label: "reveal_timeout",
      event: { type: "reveal_timeout" },
    },
  ],
});

registerResolutionPolicy({
  marketType: "next_turn",
  description:
    "Settle when the driver has committed to a direction at the turn pin " +
    "(proximity crossing confirms pass-through, heading fallback detects early " +
    "turns). reveal_at is the unconditional safety cap.",
  conditions: [
    {
      label: "turn_committed",
      event: {
        type: "turn_pin_proximity",
        approachRadiusM: 35,
        departureM: 12,
        headingFallbackDeg: 50,
      },
    },
    {
      label: "reveal_timeout",
      event: { type: "reveal_timeout" },
    },
  ],
});

registerResolutionPolicy({
  marketType: "city_grid",
  description:
    "Settle when the driver moves to a different grid cell (sweep fallback " +
    "for markets that didn't settle at locks_at). reveal_at is the safety cap.",
  conditions: [
    {
      label: "cell_crossed",
      event: { type: "cell_crossed" },
    },
    {
      label: "reveal_timeout",
      event: { type: "reveal_timeout" },
    },
  ],
});

registerResolutionPolicy({
  marketType: "next_step",
  description:
    "Refund when the driver leaves the planned path to the pin (> " +
    `${NEXT_STEP_ROUTE_DEVIATION_M} m off-route). Settle when they reach the ` +
    `maneuver point (within ${NEXT_STEP_APPROACH_M} m AND ${NEXT_STEP_DEPARTURE_M} m ` +
    "departure), or heading changes ≥ 50°. reveal_at is the safety cap.",
  conditions: [
    {
      label: "route_deviation",
      event: {
        type: "route_deviation",
        maxOffRouteM: NEXT_STEP_ROUTE_DEVIATION_M,
      },
    },
    {
      label: "step_reached",
      event: {
        type: "turn_pin_proximity",
        approachRadiusM: NEXT_STEP_APPROACH_M,
        departureM: NEXT_STEP_DEPARTURE_M,
        headingFallbackDeg: 50,
      },
    },
    {
      label: "reveal_timeout",
      event: { type: "reveal_timeout" },
    },
  ],
});

registerResolutionPolicy({
  marketType: "overtake_30s",
  description:
    "Settle from lead-vehicle telemetry (lost while approaching = yes; " +
    "30s window elapsed = no). reveal_at is the safety cap.",
  conditions: [
    {
      label: "reveal_timeout",
      event: { type: "reveal_timeout" },
    },
  ],
});
