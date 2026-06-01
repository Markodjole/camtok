/**
 * Emergency brakes for Google Routes API spend.
 *
 * Set GOOGLE_ROUTES_DISABLED=1 in production to stop all computeRoutes calls.
 * Set GOOGLE_ROUTES_MAX_PER_MIN (default 20) to cap per-server-instance volume.
 */

const WINDOW_MS = 60_000;
const DEFAULT_MAX_PER_MIN = 20;

let windowStartMs = Date.now();
let windowCount = 0;

export function googleRoutesDisabled(): boolean {
  const disabled = process.env.GOOGLE_ROUTES_DISABLED;
  if (disabled === "1" || disabled === "true" || disabled === "yes") return true;
  if (disabled === "0" || disabled === "false" || disabled === "no") return false;

  // Production default: routes off until GOOGLE_ROUTES_ENABLED=1 is set explicitly.
  // Prevents runaway computeRoutes bills if env is misconfigured.
  if (process.env.NODE_ENV === "production") {
    return process.env.GOOGLE_ROUTES_ENABLED !== "1";
  }

  return false;
}

function maxPerMinute(): number {
  const raw = process.env.GOOGLE_ROUTES_MAX_PER_MIN;
  if (raw == null || raw === "") return DEFAULT_MAX_PER_MIN;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_PER_MIN;
}

export type GoogleRouteGuardResult =
  | { allowed: true }
  | { allowed: false; reason: "disabled" | "rate_limited" };

/** Returns whether a live computeRoutes call is permitted right now. */
export function checkGoogleRouteAllowed(): GoogleRouteGuardResult {
  if (googleRoutesDisabled()) {
    return { allowed: false, reason: "disabled" };
  }

  const now = Date.now();
  if (now - windowStartMs >= WINDOW_MS) {
    windowStartMs = now;
    windowCount = 0;
  }

  if (windowCount >= maxPerMinute()) {
    console.warn("[googleRouteGuard] rate limit hit", {
      windowCount,
      maxPerMinute: maxPerMinute(),
    });
    return { allowed: false, reason: "rate_limited" };
  }

  return { allowed: true };
}

/** Call immediately before issuing a computeRoutes request. */
export function recordGoogleRouteCall(): void {
  const now = Date.now();
  if (now - windowStartMs >= WINDOW_MS) {
    windowStartMs = now;
    windowCount = 0;
  }
  windowCount++;
}
