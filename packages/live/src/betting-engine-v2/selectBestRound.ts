import { TURN_BET_OFFER_MAX_M, TURN_BET_OFFER_MIN_M } from "./constants";
import { isMvpEnabledFor, type LiveRoundSelectionSnapshot } from "./snapshot";
import type { RoundPlanV2 } from "./types";

export function canBuildNextTurnRound(s: LiveRoundSelectionSnapshot): boolean {
  const d = s.distanceToTurnMeters;
  if (d == null || !Number.isFinite(d)) return false;
  return (
    d <= TURN_BET_OFFER_MAX_M &&
    d >= TURN_BET_OFFER_MIN_M &&
    Boolean(s.nextPinHasValidBranches)
  );
}

/** All round plans that pass snapshot gates, highest priority first. */
export function listEligibleRounds(
  snapshot: LiveRoundSelectionSnapshot,
  opts?: { mvpOnly?: boolean },
): RoundPlanV2[] {
  const mvpOnly = opts?.mvpOnly ?? true;
  const out: RoundPlanV2[] = [];

  if (canBuildNextTurnRound(snapshot) && isMvpEnabledFor("next_turn", mvpOnly)) {
    out.push({ type: "next_turn", priority: 100, kind: "shared_event" });
  }
  if (snapshot.canBuildNextZoneRound && isMvpEnabledFor("next_zone", mvpOnly)) {
    out.push({ type: "next_zone", priority: 80, kind: "personal_snapshot" });
  }
  if (snapshot.canBuildZoneExitRound && isMvpEnabledFor("zone_exit_time", mvpOnly)) {
    out.push({ type: "zone_exit_time", priority: 75, kind: "personal_snapshot" });
  }

  return out;
}

export function selectBestRound(
  snapshot: LiveRoundSelectionSnapshot,
  opts?: { mvpOnly?: boolean },
): RoundPlanV2 | null {
  const plans = listEligibleRounds(snapshot, opts);
  return plans[0] ?? null;
}
