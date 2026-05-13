import { canBuildNextTurnRound } from "./selectBestRound";
import type { LiveRoundSelectionSnapshot } from "./snapshot";
import type { BettingPatternV2 } from "./types";

/**
 * Lightweight tagging for analytics / difficulty. Expand as telemetry grows.
 */
export function detectPattern(snapshot: LiveRoundSelectionSnapshot): BettingPatternV2 | undefined {
  if (canBuildNextTurnRound(snapshot)) return "approaching_turn";
  if (snapshot.nextPinId) return "time_to_pin";
  if (snapshot.canBuildZoneExitRound) return "zone_exit";
  if (snapshot.isInOrNearZone) return "dense_city";
  return undefined;
}
