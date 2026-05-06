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
        { id: "faster_2plus",   label: "2+ min faster than Google", shortLabel: "2+ min faster", displayOrder: 0 },
        { id: "faster_under2",  label: "Under 2 min faster",        shortLabel: "< 2 min faster", displayOrder: 1 },
        { id: "same_google",    label: "Same as Google ±1 min",     shortLabel: "Same ±1 min",    displayOrder: 2 },
        { id: "slower_google",  label: "Slower than Google",        shortLabel: "Slower",          displayOrder: 3 },
      ];
    case "stop_count":
      return [
        { id: "stops_0",     label: "No stops",          shortLabel: "0 stops",  displayOrder: 0 },
        { id: "stops_1",     label: "1 stop",            shortLabel: "1 stop",   displayOrder: 1 },
        { id: "stops_2",     label: "2 stops",           shortLabel: "2 stops",  displayOrder: 2 },
        { id: "stops_3plus", label: "3 or more stops",   shortLabel: "3+ stops", displayOrder: 3 },
      ];
    case "turn_count_to_pin":
      return [
        { id: "turns_1",    label: "Just 1 turn",      shortLabel: "1 turn",   displayOrder: 0 },
        { id: "turns_2_3",  label: "2–3 turns",        shortLabel: "2–3",      displayOrder: 1 },
        { id: "turns_4_5",  label: "4–5 turns",        shortLabel: "4–5",      displayOrder: 2 },
        { id: "turns_6plus",label: "6 or more turns",  shortLabel: "6+",       displayOrder: 3 },
      ];
    case "turns_before_zone_exit":
      return [
        { id: "zone_turns_0_1",  label: "0 or 1 turns",     shortLabel: "0–1",  displayOrder: 0 },
        { id: "zone_turns_2_3",  label: "2–3 turns",        shortLabel: "2–3",  displayOrder: 1 },
        { id: "zone_turns_4_5",  label: "4–5 turns",        shortLabel: "4–5",  displayOrder: 2 },
        { id: "zone_turns_6plus",label: "6 or more turns",  shortLabel: "6+",   displayOrder: 3 },
      ];
    case "zone_exit_time":
      return [
        { id: "exit_under45s", label: "Under 45 seconds",    shortLabel: "< 45s",    displayOrder: 0 },
        { id: "exit_45_90s",   label: "45–90 seconds",       shortLabel: "45–90s",   displayOrder: 1 },
        { id: "exit_90_180s",  label: "1.5 to 3 minutes",    shortLabel: "1.5–3 min",displayOrder: 2 },
        { id: "exit_over3m",   label: "Over 3 minutes",      shortLabel: "3+ min",   displayOrder: 3 },
      ];
    default:
      return [];
  }
}
