import type { BetTypeV2 } from "./types";

export type { BetTypeV2 };

/**
 * Minimal live snapshot for *pure* round selection (no I/O).
 * Populate from room state + route service + zones in adapters.
 */
export type LiveRoundSelectionSnapshot = {
  distanceToTurnMeters?: number | null;
  nextPinHasValidBranches?: boolean;
  nextPinId?: string | null;
  /** Driver inside or near a known analytics/HR zone */
  isInOrNearZone?: boolean;
  /** Next-zone question is resolvable with 2–3 clear candidates */
  canBuildNextZoneRound?: boolean;
  canBuildZoneExitRound?: boolean;
  canBuildZoneDurationRound?: boolean;
  /** Google (or primary routing) ETA to next pin available */
  canBuildTimeVsGoogleRound?: boolean;
  canBuildStopCountRound?: boolean;
  canBuildTurnCountRound?: boolean;
  canBuildTurnsBeforeZoneExitRound?: boolean;
  canBuildEtaDriftRound?: boolean;
};

/**
 * Which bet types are allowed in current MVP (guide §22).
 */
export const MVP_BET_TYPES_V2: ReadonlySet<BetTypeV2> = new Set([
  "next_turn",
  "next_zone",
  "turns_before_zone_exit",
  "stop_count",
  "zone_exit_time",
  "time_vs_google",
]);

export function isMvpBetType(type: BetTypeV2): boolean {
  return MVP_BET_TYPES_V2.has(type);
}

export function isMvpEnabledFor(type: BetTypeV2, mvpOnly: boolean): boolean {
  return !mvpOnly || MVP_BET_TYPES_V2.has(type);
}
