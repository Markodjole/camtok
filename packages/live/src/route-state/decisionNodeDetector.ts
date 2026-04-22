import type { RouteDecisionOption, TransportMode } from "../types";
import type { NormalizedPoint } from "./gpsNormalizer";

/**
 * Minimum time-before-decision required to safely open a betting window.
 * Kept high enough that the driver sees the instruction well before the turn.
 */
export const MIN_LOCK_WINDOW_SEC: Record<TransportMode, number> = {
  walking: 12,
  bike: 14,
  scooter: 18,
  car: 22,
  other_vehicle: 22,
};

export const MAX_LOCK_WINDOW_SEC: Record<TransportMode, number> = {
  walking: 25,
  bike: 30,
  scooter: 38,
  car: 45,
  other_vehicle: 45,
};

export type DecisionCandidate = {
  currentNodeId: string;
  currentEdgeId?: string | null;
  triggerDistanceMeters: number;
  triggerEtaSeconds: number;
  options: RouteDecisionOption[];
  confidence: number;
};

/**
 * V1 detector: heuristic, map-less.
 *
 * Uses short-window motion statistics to infer when a user is approaching
 * a decision-worthy moment (slow-down, heading change, near place boundary
 * via hint). Map-matched detectors can replace this with graph queries later.
 */
export function detectNextDecision(
  recent: NormalizedPoint[],
  transportMode: TransportMode,
): DecisionCandidate | null {
  const usable = recent.filter((p) => !p.discarded).slice(-8);
  if (usable.length < 3) return null;

  const last = usable[usable.length - 1];
  const prev = usable[usable.length - 2];
  const speed = last.speedMps ?? 0;
  const prevSpeed = prev.speedMps ?? speed;

  const minEta = MIN_LOCK_WINDOW_SEC[transportMode];
  const maxEta = MAX_LOCK_WINDOW_SEC[transportMode];

  const slowing = speed < prevSpeed * 0.7;
  const steady = Math.abs(speed - prevSpeed) < 0.5;

  let etaSec: number;
  let distanceMeters: number;
  let confidence: number;

  if (slowing && speed > 0.1) {
    // Slow-down detected — use speed to project how far ahead the decision is.
    // Lower bound is minEta so the window is always wide enough.
    etaSec = Math.min(maxEta, Math.max(minEta, minEta + (1 / speed) * 4));
    distanceMeters = Math.max(10, speed * etaSec);
    confidence = 0.65;
  } else if (steady && speed > 0.3) {
    // Steady speed — open early, use the full min window so driver has time.
    etaSec = Math.min(maxEta, Math.max(minEta, minEta));
    distanceMeters = speed * etaSec;
    confidence = 0.55;
  } else {
    return null;
  }

  if (etaSec < minEta) return null;

  const options: RouteDecisionOption[] = pickOptionsForContext(transportMode, slowing);

  return {
    currentNodeId: `virtual:${last.recordedAt}`,
    currentEdgeId: null,
    triggerDistanceMeters: distanceMeters,
    triggerEtaSeconds: etaSec,
    options,
    confidence,
  };
}

function pickOptionsForContext(
  transportMode: TransportMode,
  slowing: boolean,
): RouteDecisionOption[] {
  if (slowing) {
    if (transportMode === "walking" || transportMode === "bike" || transportMode === "scooter") {
      return [
        { optionId: "enter", label: "Enters / stops here", directionType: "enter" },
        { optionId: "continue", label: "Keeps going", directionType: "continue" },
      ];
    }
    return [
      { optionId: "stop", label: "Stops", directionType: "stop" },
      { optionId: "continue", label: "Continues", directionType: "continue" },
    ];
  }
  return [
    { optionId: "left", label: "Turns left", directionType: "left" },
    { optionId: "straight", label: "Goes straight", directionType: "straight" },
    { optionId: "right", label: "Turns right", directionType: "right" },
  ];
}
