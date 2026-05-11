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
  "zone_duration",
  "eta_drift",
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

/** Placeholder options when no matching market row exists — reads like real stakes. */
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
    case "time_vs_google":
      return [
        {
          id: "faster_google",
          label: "Beat Google ETA to the next pin",
          shortLabel: "Beat ETA",
          displayOrder: 0,
        },
        {
          id: "slower_google",
          label: "Slower than Google ETA to the next pin",
          shortLabel: "Slower",
          displayOrder: 1,
        },
      ];
    case "stop_count":
      return [
        {
          id: "stops_low",
          label: "At most one full stop (lights / traffic)",
          shortLabel: "0–1 stops",
          displayOrder: 0,
        },
        {
          id: "stops_high",
          label: "Two or more full stops before leaving zone",
          shortLabel: "2+ stops",
          displayOrder: 1,
        },
      ];
    case "turn_count_to_pin":
      return [
        {
          id: "turns_few",
          label: "One or two turns before the next pin",
          shortLabel: "1–2 turns",
          displayOrder: 0,
        },
        {
          id: "turns_many",
          label: "Three or more turns before the next pin",
          shortLabel: "3+ turns",
          displayOrder: 1,
        },
      ];
    case "turns_before_zone_exit":
      return [
        {
          id: "zone_turns_few",
          label: "At most one turn before exiting this zone",
          shortLabel: "0–1 turns",
          displayOrder: 0,
        },
        {
          id: "zone_turns_many",
          label: "Two or more turns before exiting this zone",
          shortLabel: "2+ turns",
          displayOrder: 1,
        },
      ];
    case "zone_exit_time":
      return [
        {
          id: "exit_fast",
          label: "Leaves the zone in under 90 seconds",
          shortLabel: "< 90 s",
          displayOrder: 0,
        },
        {
          id: "exit_slow",
          label: "Still in zone after 90 seconds",
          shortLabel: "90 s+",
          displayOrder: 1,
        },
      ];
    case "zone_duration":
      return [
        {
          id: "dur_short",
          label: "In this zone less than 2 minutes total",
          shortLabel: "< 2 min",
          displayOrder: 0,
        },
        {
          id: "dur_long",
          label: "Stays in this zone 2 minutes or longer",
          shortLabel: "2 min+",
          displayOrder: 1,
        },
      ];
    case "eta_drift":
      return [
        {
          id: "eta_early",
          label: "Arrives noticeably ahead of live ETA",
          shortLabel: "Ahead",
          displayOrder: 0,
        },
        {
          id: "eta_late",
          label: "Arrives behind the live ETA window",
          shortLabel: "Behind",
          displayOrder: 1,
        },
      ];
    default:
      return [];
  }
}
