/**
 * Bet timing and spatial trigger thresholds.
 *
 * These are the ONLY conditions that control when a market opens, when the
 * viewer sees a popup, and when betting is unlocked.
 *
 * Product rules:
 *  - next_zone       → fires ONCE per zone cell when driver ≤ 100 m from cell center
 *  - zone_exit_time  → fires up to 3× per zone:
 *                       1) on zone entry (driver inside the cell)
 *                       2) when driver ≤ 70 m from cell center
 *                       3) when driver ≥ 100 m from center after having been within 70 m
 *  - next_turn       → fires once per pin when driver is within [90 m, 150 m] of next pin
 *                       (120 m nominal ± 30 m tolerance)
 *  - If a trigger fires while a bet is already showing, it is queued and
 *    opens immediately when the screen clears (see tick route).
 */

/**
 * Bet popup minimum display time. Every market stays open for at least this long.
 * When the queue is empty the opener extends to BET_OPEN_WINDOW_IDLE_MS instead.
 */
export const BET_OPEN_WINDOW_MS = 8_000;

/**
 * Extended window used when there are no queued triggers waiting — viewer gets
 * the full 12 seconds to decide.
 */
export const BET_OPEN_WINDOW_IDLE_MS = 12_000;

// ─── next_zone ────────────────────────────────────────────────────────────────

/** Open next_zone when driver is within this distance of current cell center (m). */
export const NEXT_ZONE_TRIGGER_M = 100;

// ─── zone_exit_time ───────────────────────────────────────────────────────────

/** Phase 2: open when driver ≤ this distance from cell center (m). */
export const ZONE_EXIT_CENTER_TRIGGER_M = 70;

/**
 * Phase 3 min distance: open when driver ≥ this far from cell center AND
 * phase 2 has already fired (driver was close to center, now moving outward).
 */
export const ZONE_EXIT_OUTER_TRIGGER_MIN_M = 100;

// ─── next_turn ────────────────────────────────────────────────────────────────

/** Nominal distance at which next_turn triggers (m). */
export const NEXT_TURN_PIN_TARGET_M = 120;

/** Window around the nominal distance: trigger fires while dist is in [MIN, MAX]. */
export const NEXT_TURN_PIN_MIN_M = 90;
export const NEXT_TURN_PIN_MAX_M = 150;

// ─── Legacy alias (used in live-markets.ts client-side lock check) ────────────

/** @deprecated use NEXT_ZONE_TRIGGER_M */
export const ZONE_BET_CENTER_RADIUS_M = NEXT_ZONE_TRIGGER_M;
