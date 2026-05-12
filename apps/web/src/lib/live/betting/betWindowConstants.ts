/**
 * Bet timing + spatial gates shared across server (open-market actions, tick)
 * and viewer client (popup display window).
 *
 * The product rule today is "every bet stays on screen 7 seconds OR until the
 * viewer bets, whichever comes first". `BET_OPEN_WINDOW_MS` is enforced on the
 * server via `locks_at = opens_at + window`, and on the client by hiding the
 * bet card when `now >= locks_at`.
 */
export const BET_OPEN_WINDOW_MS = 7_000;

/**
 * Zone-class bets (`next_zone`, `zone_exit_time`) only open while the driver
 * is within this many meters of the *center* of their current grid cell.
 * Outside the inner circle the user explicitly does not want these bets.
 */
export const ZONE_BET_CENTER_RADIUS_M = 100;

/**
 * `next_turn` (left / right / straight) only opens while the next blue pin is
 * inside this distance window from the driver. The user asked for "150 m
 * from next blue pin with more or less 20 m".
 */
export const NEXT_TURN_PIN_TARGET_M = 150;
export const NEXT_TURN_PIN_TOLERANCE_M = 20;
export const NEXT_TURN_PIN_MIN_M =
  NEXT_TURN_PIN_TARGET_M - NEXT_TURN_PIN_TOLERANCE_M;
export const NEXT_TURN_PIN_MAX_M =
  NEXT_TURN_PIN_TARGET_M + NEXT_TURN_PIN_TOLERANCE_M;
