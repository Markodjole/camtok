/**
 * Relaxed betting windows + no early distance lock for local QA.
 *
 * Server: set `LIVE_RELAX_BETTING=1` in apps/web env (e.g. .env.local).
 * Client lock hints: also set `NEXT_PUBLIC_LIVE_RELAX_BETTING=1` so the UI
 * matches (time/distance gates hidden); server still enforces real locks if
 * only one side is set.
 */

export function liveBetRelaxServer(): boolean {
  const v = process.env.LIVE_RELAX_BETTING ?? "";
  return v === "1" || v.toLowerCase() === "true";
}

export function liveBetRelaxClient(): boolean {
  const v = process.env.NEXT_PUBLIC_LIVE_RELAX_BETTING ?? "";
  return v === "1" || v.toLowerCase() === "true";
}
