import type { BetTypeV2 } from "@bettok/live";

export type EngineMarketOption = {
  id: string;
  label: string;
  shortLabel: string;
  displayOrder: number;
};

/** Market types that are engine-driven provisional bets (no real GPS-resolved outcome yet). */
export const ENGINE_BET_TYPES = new Set<string>([
  "time_vs_google",
  "stop_count",
  "turn_count_to_pin",
  "turns_before_zone_exit",
  "zone_exit_time",
]);

export function isEngineMarketType(marketType: string): boolean {
  return ENGINE_BET_TYPES.has(marketType);
}

/** Returns selectable options for provisional engine bets. */
export function provisionalOptionsForBetType(type: BetTypeV2): EngineMarketOption[] {
  switch (type) {
    case "time_vs_google":
      return [
        { id: "faster_google", label: "Faster than Google", shortLabel: "Faster", displayOrder: 0 },
        { id: "slower_google", label: "Slower than Google", shortLabel: "Slower", displayOrder: 1 },
      ];
    case "stop_count":
      return [
        { id: "stops_low", label: "0-1 stops", shortLabel: "0-1 stops", displayOrder: 0 },
        { id: "stops_high", label: "2+ stops", shortLabel: "2+ stops", displayOrder: 1 },
      ];
    case "turn_count_to_pin":
      return [
        { id: "turns_few", label: "1-2 turns", shortLabel: "1-2 turns", displayOrder: 0 },
        { id: "turns_many", label: "3+ turns", shortLabel: "3+ turns", displayOrder: 1 },
      ];
    case "turns_before_zone_exit":
      return [
        { id: "zone_turns_few", label: "0-1 turns", shortLabel: "0-1 turns", displayOrder: 0 },
        { id: "zone_turns_many", label: "2+ turns", shortLabel: "2+ turns", displayOrder: 1 },
      ];
    case "zone_exit_time":
      return [
        { id: "exit_fast", label: "Under 90 seconds", shortLabel: "< 90s", displayOrder: 0 },
        { id: "exit_slow", label: "90+ seconds", shortLabel: "90s+", displayOrder: 1 },
      ];
    default:
      return [];
  }
}
