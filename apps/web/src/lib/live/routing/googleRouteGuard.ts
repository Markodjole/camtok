/**
 * Google Routes API guard — delegates to shared apiUsage caps.
 */
import {
  assertApiAllowed,
  checkApiAllowed,
  googleRoutesDisabled,
  recordApiCall,
  type ApiGuardResult,
} from "@/lib/usage/apiUsage";

export type GoogleRouteGuardResult =
  | { allowed: true }
  | { allowed: false; reason: "disabled" | "rate_limited" };

export { googleRoutesDisabled };

function mapReason(
  r: ApiGuardResult,
): GoogleRouteGuardResult {
  if (r.allowed) return { allowed: true };
  if (r.reason === "disabled") return { allowed: false, reason: "disabled" };
  return { allowed: false, reason: "rate_limited" };
}

export function checkGoogleRouteAllowed(): GoogleRouteGuardResult {
  return mapReason(checkApiAllowed("google_routes"));
}

export function recordGoogleRouteCall(): void {
  recordApiCall("google_routes");
}

/** Check + record in one step (preferred at call sites). */
export function guardGoogleRouteCall(): GoogleRouteGuardResult {
  return mapReason(assertApiAllowed("google_routes"));
}
