import type { LiveSafetyLevel, TransportMode } from "../types";

export type TransportPolicy = {
  mode: TransportMode;
  allowSystemMarkets: boolean;
  allowUserMarkets: boolean;
  safetyLevel: LiveSafetyLevel;
  minLockWindowSec: number;
  maxLockWindowSec: number;
  /**
   * When true, user market proposals must be approved by owner/mod before
   * going live. Required for higher-risk modes.
   */
  requireOwnerApproval: boolean;
};

export function policyFor(mode: TransportMode): TransportPolicy {
  switch (mode) {
    case "walking":
      return {
        mode,
        allowSystemMarkets: true,
        allowUserMarkets: true,
        safetyLevel: "normal",
        minLockWindowSec: 10,
        maxLockWindowSec: 20,
        requireOwnerApproval: false,
      };
    case "bike":
    case "scooter":
      return {
        mode,
        allowSystemMarkets: true,
        allowUserMarkets: true,
        safetyLevel: "normal",
        minLockWindowSec: 8,
        maxLockWindowSec: 15,
        requireOwnerApproval: true,
      };
    case "car":
    case "other_vehicle":
      return {
        mode,
        allowSystemMarkets: false, // V1: disabled by default
        allowUserMarkets: false,
        safetyLevel: "restricted",
        minLockWindowSec: 6,
        maxLockWindowSec: 12,
        requireOwnerApproval: true,
      };
  }
}

/**
 * Final guard that validates every market candidate against active policy.
 */
export function marketIsAllowed(policy: TransportPolicy, isUserGenerated: boolean): boolean {
  if (policy.safetyLevel === "blocked") return false;
  if (isUserGenerated) return policy.allowUserMarkets;
  return policy.allowSystemMarkets;
}
