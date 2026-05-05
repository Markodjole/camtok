import { BET_TYPE_PRIORITY_V2 } from "./constants";
import type { BetRoundV2 } from "./types";
import type { RoundPlanV2 } from "./types";

/**
 * Whether to rotate the single active round to a new plan (guide §16).
 * Call after computing `selectBestRound`; update provisional when this returns false and type matches.
 */
export function shouldReplaceRound(params: {
  current: BetRoundV2 | null | undefined;
  nextPlan: RoundPlanV2;
  /** User has a personal bet mid-resolution — do not swap card. */
  userHasResolvingPersonalBet: boolean;
  /** Shared turn market locked server-side — keep UX pinned. */
  sharedTurnLocked: boolean;
}): boolean {
  const { current, nextPlan, userHasResolvingPersonalBet, sharedTurnLocked } = params;

  if (!current) return true;
  if (current.state === "resolved" || current.state === "voided") return true;

  if (
    userHasResolvingPersonalBet &&
    current.kind === "personal_snapshot" &&
    current.state === "resolving"
  ) {
    return false;
  }

  if (sharedTurnLocked && current.type === "next_turn" && current.kind === "shared_event") {
    return false;
  }

  if (current.type === nextPlan.type) return false;

  const curPri = BET_TYPE_PRIORITY_V2[current.type] ?? 0;
  return nextPlan.priority > curPri;
}
