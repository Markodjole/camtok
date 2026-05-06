/**
 * Betting Engine V2 — shared constants (product guide).
 * Server tick / legacy UI may use slightly different thresholds until fully migrated.
 */

import type { BetTypeV2 } from "./types";

/** Offer next-turn(shared) when distance to decision is within this band (m). */
export const TURN_BET_OFFER_MAX_M = 200;
export const TURN_BET_OFFER_MIN_M = 150;

/**
 * In-zone bets (`turns_before_zone_exit`, `stop_count`) fire after entering a zone.
 * `next_zone` fires when the driver is past the first ~40 % of the cell (middle-ish).
 */
export const ZONE_MIDDLE_FRACTION = 0.4;

/** Primary close trigger: closer than this locks the shared turn round (m). */
export const TURN_BET_LOCK_DISTANCE_M = 60;

/** Personal snapshot: stop if speed below this for STOP_MIN_DURATION_MS. */
export const STOP_SPEED_THRESHOLD_MPS = 0.7;
export const STOP_MIN_DURATION_MS = 2000;

/** ETA drift personal bet measurement window. */
export const ETA_DRIFT_WINDOW_MS = 15_000;

/** Engine tick target (ms) — client/server loops can aim near this. */
export const ROUND_ENGINE_TICK_TARGET_MS = 750;

/** Max signals on universal bet card. */
export const MAX_BET_SIGNALS = 3;

/** Heading change threshold for “real” turn vs lane bend (deg). */
export const TURN_COUNT_HEADING_DELTA_MIN_DEG = 35;

/** Priority when choosing / replacing rounds (guide §4). Higher = more important. */
export const BET_TYPE_PRIORITY_V2: Record<BetTypeV2, number> = {
  next_turn: 100,
  next_zone: 80,
  zone_exit_time: 75,
  zone_duration: 74,
  time_vs_google: 70,
  stop_count: 60,
  turns_before_zone_exit: 56,
  turn_count_to_pin: 55,
  eta_drift: 40,
};
