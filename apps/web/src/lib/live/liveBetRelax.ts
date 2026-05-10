/**
 * Relaxed betting windows + no early distance lock for local QA.
 *
 * Server: set `LIVE_RELAX_BETTING=1` in apps/web env (e.g. .env.local).
 * Client lock hints: also set `NEXT_PUBLIC_LIVE_RELAX_BETTING=1` so the UI
 * matches (time/distance gates hidden); server still enforces real locks if
 * only one side is set.
 */

/**
 * TEMPORARY: flip to `false` before shipping — bypasses distance/time locks on
 * client + server (`liveBetRelaxServer` / `liveBetRelaxClient`) so every bet
 * stays placeable while product rules are iterated.
 */
export const LIVE_BET_UNLOCK_ALL_TEMP = true;

export function liveBetRelaxServer(): boolean {
  if (LIVE_BET_UNLOCK_ALL_TEMP) return true;
  const v = process.env.LIVE_RELAX_BETTING ?? "";
  return v === "1" || v.toLowerCase() === "true";
}

export function liveBetRelaxClient(): boolean {
  if (LIVE_BET_UNLOCK_ALL_TEMP) return true;
  const v = process.env.NEXT_PUBLIC_LIVE_RELAX_BETTING ?? "";
  return v === "1" || v.toLowerCase() === "true";
}
