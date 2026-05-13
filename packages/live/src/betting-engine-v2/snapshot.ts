import type { BetTypeV2 } from "./types";

export type { BetTypeV2 };

/**
 * Minimal live snapshot for pure round selection (no I/O).
 * Only flags needed for the 3 active bet types.
 */
export type LiveRoundSelectionSnapshot = {
  distanceToTurnMeters?: number | null;
  nextPinHasValidBranches?: boolean;
  nextPinId?: string | null;
  /** Driver inside or near a known zone */
  isInOrNearZone?: boolean;
  /** next_zone: driver in zone with clear adjacent cells */
  canBuildNextZoneRound?: boolean;
  /** zone_exit_time: driver is in zone */
  canBuildZoneExitRound?: boolean;
};

/** The only 3 active bet types. */
export const MVP_BET_TYPES_V2: ReadonlySet<BetTypeV2> = new Set([
  "next_turn",
  "next_zone",
  "zone_exit_time",
]);

export function isMvpBetType(type: BetTypeV2): boolean {
  return MVP_BET_TYPES_V2.has(type);
}

export function isMvpEnabledFor(type: BetTypeV2, mvpOnly: boolean): boolean {
  return !mvpOnly || MVP_BET_TYPES_V2.has(type);
}
