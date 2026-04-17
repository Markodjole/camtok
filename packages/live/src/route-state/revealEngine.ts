import type { LiveMarketOption, RouteDecisionNode, TransportMode } from "../types";
import type { NormalizedPoint } from "./gpsNormalizer";

export type RevealResult =
  | { status: "matched"; winningOptionId: string; reason: string }
  | { status: "ambiguous"; reason: string }
  | { status: "insufficient_confidence"; reason: string };

/**
 * Compare actual movement after lock time against the locked option set and
 * pick the option the character committed to. If confidence is too low,
 * return a soft result so callers can cancel + refund.
 */
export function revealFromMovement(
  options: LiveMarketOption[],
  decision: Pick<RouteDecisionNode, "options"> | null,
  committedPath: NormalizedPoint[],
): RevealResult {
  const usable = committedPath.filter((p) => !p.discarded);
  if (usable.length < 3) {
    return { status: "insufficient_confidence", reason: "not_enough_points" };
  }

  if (!decision) {
    return { status: "ambiguous", reason: "missing_decision_reference" };
  }

  const first = usable[0];
  const last = usable[usable.length - 1];
  const avgSpeed =
    usable.reduce((s, p) => s + (p.speedMps ?? 0), 0) / usable.length;
  const headingDelta = angleDelta(
    first.headingDeg ?? 0,
    last.headingDeg ?? 0,
  );

  const optionByDirection = new Map<string, string>();
  for (const opt of decision.options) {
    optionByDirection.set(opt.directionType, opt.optionId);
  }

  if (avgSpeed < 0.2) {
    const stop = optionByDirection.get("stop") ?? optionByDirection.get("enter");
    if (stop && options.some((o) => o.id === stop)) {
      return { status: "matched", winningOptionId: stop, reason: "dwell_detected" };
    }
  }

  if (headingDelta > 45) {
    const left = optionByDirection.get("left");
    if (left && options.some((o) => o.id === left)) {
      return { status: "matched", winningOptionId: left, reason: "left_turn_detected" };
    }
  } else if (headingDelta < -45) {
    const right = optionByDirection.get("right");
    if (right && options.some((o) => o.id === right)) {
      return { status: "matched", winningOptionId: right, reason: "right_turn_detected" };
    }
  } else {
    const straight =
      optionByDirection.get("straight") ?? optionByDirection.get("continue");
    if (straight && options.some((o) => o.id === straight)) {
      return { status: "matched", winningOptionId: straight, reason: "heading_stable" };
    }
  }

  return { status: "ambiguous", reason: "no_clear_direction_match" };
}

function angleDelta(a: number, b: number): number {
  let d = b - a;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

export function minimumSamplesForReveal(_mode: TransportMode): number {
  return 3;
}
