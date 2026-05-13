/**
 * Market odds computation.
 *
 * Odds are calculated once at market-open time by the server-side tick worker
 * and stored in live_betting_markets.odds so every viewer reads the same
 * numbers regardless of which serverless instance handles their /state poll.
 *
 * Format: decimal odds (European style).
 * House margin: 5 % overround — for N equal-probability options the decimal
 * odds are N / 1.05.  Future versions can replace the equal-probability
 * model with a position-aware model (vehicle speed, distance, etc.).
 */

export const DEFAULT_MARGIN = 0.05;

export type MarketOdds = {
  format: "decimal";
  /** House margin expressed as a fraction, e.g. 0.05 = 5 %. */
  margin: number;
  /** option_id → decimal odds (e.g. 2.86 means bet $1 to win $2.86 including stake). */
  lines: Record<string, number>;
};

/**
 * Compute equal-probability decimal odds for a list of options.
 *
 * For N options with house margin m:
 *   decimal_odds = N / (1 + m)
 *
 * Examples with m=0.05:
 *   2 options  → 1.90
 *   3 options  → 2.86
 *   9 options  → 8.57  (typical next_zone 3×3 grid)
 *  25 options  → 23.81 (typical next_zone 5×5 grid)
 */
export function computeEqualOdds(
  options: ReadonlyArray<{ id: string }>,
  margin = DEFAULT_MARGIN,
): MarketOdds {
  const n = options.length;
  const lines: Record<string, number> = {};
  if (n > 0) {
    const decimalOdds = Math.round((n / (1 + margin)) * 100) / 100;
    for (const opt of options) {
      lines[opt.id] = decimalOdds;
    }
  }
  return { format: "decimal", margin, lines };
}
