import { canBuildNextTurnRound } from "./selectBestRound";
import type { LiveRoundSelectionSnapshot } from "./snapshot";
import type { BettingPatternV2 } from "./types";

/**
 * Lightweight tagging for analytics / difficulty (guide §23). Expand as telemetry grows.
 */
export function detectPattern(snapshot: LiveRoundSelectionSnapshot): BettingPatternV2 | undefined {
  if (canBuildNextTurnRound(snapshot)) return "approaching_turn";
  if (snapshot.canBuildTimeVsGoogleRound || snapshot.nextPinId) return "time_to_pin";
  if (snapshot.canBuildZoneExitRound) return "zone_exit";
  if (snapshot.canBuildStopCountRound) return "traffic_slowdown";
  if (snapshot.canBuildEtaDriftRound) return "route_deviation";
  if (snapshot.isInOrNearZone) return "dense_city";
  return undefined;
}
