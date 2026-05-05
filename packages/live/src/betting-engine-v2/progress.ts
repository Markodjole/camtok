import { TURN_BET_LOCK_DISTANCE_M, TURN_BET_OFFER_MAX_M, TURN_BET_OFFER_MIN_M } from "./constants";

/**
 * Shared-event progress 0…1: 1 = far (start of window), 0 = at lock distance (guide §17).
 */
export function sharedTurnBetProgress(distanceToTurnMeters: number): number {
  const startM = TURN_BET_OFFER_MAX_M;
  const closeM = TURN_BET_LOCK_DISTANCE_M;
  const span = startM - closeM;
  if (span <= 0) return 0;
  const t = (distanceToTurnMeters - closeM) / span;
  return Math.min(1, Math.max(0, t));
}

/** True if viewer should show the shared next-turn offer (outer window). */
export function isInTurnBetOfferWindow(distanceToTurnMeters: number | null | undefined): boolean {
  if (distanceToTurnMeters == null || !Number.isFinite(distanceToTurnMeters)) return false;
  return (
    distanceToTurnMeters <= TURN_BET_OFFER_MAX_M &&
    distanceToTurnMeters >= TURN_BET_OFFER_MIN_M
  );
}

/**
 * Personal snapshot “availability” progress from remaining time (guide §17).
 */
export function personalRoundProgress(remainingMs: number, availableDurationMs: number): number {
  if (availableDurationMs <= 0) return 0;
  return Math.min(1, Math.max(0, remainingMs / availableDurationMs));
}
