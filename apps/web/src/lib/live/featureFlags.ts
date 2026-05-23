/**
 * Live-betting feature flags.
 *
 * Set a flag to `false` to suspend a feature without deleting any code.
 * Triggers will not fire, markets will not open, and UI elements will not
 * render.  Re-enable by flipping back to `true`.
 */

/**
 * `next_turn` — Left / Straight / Right directional bets at routing pins.
 *
 * When `false`:
 *   • Server tick skips next_turn trigger detection entirely.
 *   • Client skips the driver-route fetch and passes null pins to the map
 *     (no blue pin markers or approach line).
 *   • Any existing open/locked next_turn markets are still settled normally
 *     (we never abandon mid-flight bets).
 */
export const NEXT_TURN_BETS_ENABLED = false;

/**
 * `straight_streak` bet type — fire when there are ≥ 2 consecutive "straight"
 * crossroads ahead on the planning polyline.
 * Set to `false` to suspend the trigger and opener without removing any code.
 */
export const STRAIGHT_STREAK_BETS_ENABLED = true;
