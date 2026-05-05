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

/** All round plans that pass snapshot gates, highest priority first (first entry is what {@link selectBestRound} returns). */
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
  if (snapshot.canBuildZoneDurationRound && isMvpEnabledFor("zone_duration", mvpOnly)) {
    out.push({ type: "zone_duration", priority: 74, kind: "personal_snapshot" });
  }
  if (snapshot.canBuildTimeVsGoogleRound && isMvpEnabledFor("time_vs_google", mvpOnly)) {
    out.push({ type: "time_vs_google", priority: 70, kind: "personal_snapshot" });
  }
  if (snapshot.canBuildStopCountRound && isMvpEnabledFor("stop_count", mvpOnly)) {
    out.push({ type: "stop_count", priority: 60, kind: "personal_snapshot" });
  }
  if (snapshot.canBuildTurnsBeforeZoneExitRound && isMvpEnabledFor("turns_before_zone_exit", mvpOnly)) {
    out.push({ type: "turns_before_zone_exit", priority: 56, kind: "personal_snapshot" });
  }
  if (snapshot.canBuildTurnCountRound && isMvpEnabledFor("turn_count_to_pin", mvpOnly)) {
    out.push({ type: "turn_count_to_pin", priority: 55, kind: "personal_snapshot" });
  }
  if (snapshot.canBuildEtaDriftRound && isMvpEnabledFor("eta_drift", mvpOnly)) {
    out.push({ type: "eta_drift", priority: 40, kind: "personal_snapshot" });
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
