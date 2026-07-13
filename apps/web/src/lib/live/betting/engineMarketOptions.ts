import type { BetTypeV2 } from "@bettok/live";

export type EngineMarketOption = {
  id: string;
  label: string;
  shortLabel: string;
  displayOrder: number;
};

/**
 * Market types whose outcome is resolved by the driving-telemetry engine
 * and therefore must NOT be settled immediately at `locks_at`.
 *
 * Settlement lifecycle for these types:
 *   1. `locks_at` fires   → `lockMarket` only (bets frozen, no new bets)
 *   2. sweep each tick    → checks specific outcome condition (turn committed /
 *                           zone exited / countdown elapsed)
 *   3. condition met      → `revealAndSettleMarket` (winner + payout)
 *   4. `reveal_at` safety → force-settle if outcome still pending after timeout
 *
 * Contrast with immediate-settle types (e.g. city_grid) which are resolved
 * at `locks_at` in a single lockAndSettleMarket call.
 */
export const ENGINE_BET_TYPES = new Set<string>([
  "next_turn",       // settle when driver commits turn heading
  "next_step",       // settle when driver reaches OSRM step maneuver point
  "zone_exit_time",  // settle when driver leaves start cell or countdown elapses
  "straight_streak", // settle when driver takes a non-straight at any intersection
  "overtake_30s",    // settle from lead-vehicle lost / 30s window
]);

export function isEngineMarketType(marketType: string): boolean {
  return ENGINE_BET_TYPES.has(marketType);
}

type MarketOptsRow = {
  marketType?: string;
  options?: Array<{ id: string; label: string; shortLabel?: string; displayOrder: number }>;
};

/**
 * When a market is open we always show its real `option_set` so the optionId
 * placed with the bet is one the server will accept. Placeholder options are
 * only used when there is no live market yet but a bet headline is being
 * advertised, so the sheet never looks empty.
 */
export function sheetOptionsForDisplayBet(
  displayBetType: BetTypeV2 | null,
  currentMarket: MarketOptsRow | null | undefined,
): Array<{ id: string; label: string; shortLabel?: string; displayOrder: number }> {
  const dbOptions = currentMarket?.options;
  if (dbOptions && dbOptions.length > 0) return dbOptions;
  if (!displayBetType) return [];
  return provisionalOptionsForBetType(displayBetType);
}

/** Placeholder options when no matching market row exists. */
export function provisionalOptionsForBetType(type: BetTypeV2): EngineMarketOption[] {
  switch (type) {
    case "next_turn":
      return [
        {
          id: "prov_turn_left",
          label: "Driver takes the left branch next",
          shortLabel: "Left next",
          displayOrder: 0,
        },
        {
          id: "prov_turn_right",
          label: "Driver takes the right branch next",
          shortLabel: "Right next",
          displayOrder: 1,
        },
        {
          id: "prov_turn_straight",
          label: "Driver continues straight through",
          shortLabel: "Straight",
          displayOrder: 2,
        },
      ];
    case "next_zone":
      return [
        {
          id: "prov_zone_a",
          label: "Next entered square · NW quadrant",
          shortLabel: "NW square",
          displayOrder: 0,
        },
        {
          id: "prov_zone_b",
          label: "Next entered square · SE quadrant",
          shortLabel: "SE square",
          displayOrder: 1,
        },
      ];
    case "zone_exit_time":
      return [
        { id: "exit_under", label: "Under estimated time", shortLabel: "< ? sec", displayOrder: 0 },
        { id: "exit_at",    label: "Exactly estimated time", shortLabel: "= ? sec", displayOrder: 1 },
        { id: "exit_over",  label: "Over estimated time",  shortLabel: "> ? sec", displayOrder: 2 },
      ];
    case "straight_streak":
      return [
        { id: "streak_under", label: "Fewer straights than average", shortLabel: "< avg", displayOrder: 0 },
        { id: "streak_at",    label: "About average straights",       shortLabel: "= avg", displayOrder: 1 },
        { id: "streak_over",  label: "More straights than average",   shortLabel: "> avg", displayOrder: 2 },
      ];
    case "next_step":
      return [
        { id: "step_under", label: "Reaches turn faster than estimated", shortLabel: "< ETA", displayOrder: 0 },
        { id: "step_at",    label: "Reaches turn at estimated time",      shortLabel: "≈ ETA", displayOrder: 1 },
        { id: "step_over",  label: "Reaches turn slower than estimated",  shortLabel: "> ETA", displayOrder: 2 },
      ];
    case "overtake_30s":
      return [
        {
          id: "overtake_yes",
          label: "Overtakes lead vehicle within 30s",
          shortLabel: "Yes ≤30s",
          displayOrder: 0,
        },
        {
          id: "overtake_no",
          label: "Does not overtake within 30s",
          shortLabel: "No",
          displayOrder: 1,
        },
      ];
    default:
      return [];
  }
}
