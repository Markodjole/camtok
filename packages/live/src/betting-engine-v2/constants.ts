/**
 * Betting Engine V2 — shared constants.
 * Active bet types: next_turn, next_zone, zone_exit_time.
 */

import type { BetTypeV2 } from "./types";

/** Offer next_turn when distance to decision pin is within this band (m). */
export const TURN_BET_OFFER_MAX_M = 200;
export const TURN_BET_OFFER_MIN_M = 150;

/** In-zone bets fire after entering a zone. */
export const ZONE_MIDDLE_FRACTION = 0.4;

/** Primary close trigger: closer than this locks the shared turn round (m). */
export const TURN_BET_LOCK_DISTANCE_M = 60;

/** Engine tick target (ms). */
export const ROUND_ENGINE_TICK_TARGET_MS = 750;

/** Max signals on universal bet card. */
export const MAX_BET_SIGNALS = 3;

/** Heading change threshold for "real" turn vs lane bend (deg). */
export const TURN_COUNT_HEADING_DELTA_MIN_DEG = 35;

/** Priority when choosing / replacing rounds. Higher = more important. */
export const BET_TYPE_PRIORITY_V2: Record<BetTypeV2, number> = {
  next_turn: 100,
  next_zone: 80,
  zone_exit_time: 75,
};
