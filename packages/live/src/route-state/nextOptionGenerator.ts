import type { RouteDecisionOption, TransportMode } from "../types";

export type MarketDraft = {
  title: string;
  subtitle?: string;
  marketType:
    | "next_direction"
    | "entry_vs_skip"
    | "continue_vs_turn"
    | "next_stop"
    | "left_right_split";
  options: Array<{ id: string; label: string; shortLabel?: string; displayOrder: number }>;
};

/**
 * Turn a decision-node option set into a human-friendly market draft.
 * Labels and title are generated to feel natural in a live room header.
 */
export function buildMarketDraftFromOptions(
  characterName: string,
  transportMode: TransportMode,
  options: RouteDecisionOption[],
): MarketDraft {
  const types = new Set(options.map((o) => o.directionType));

  const optionRows = options.map((o, i) => ({
    id: o.optionId,
    label: o.label,
    shortLabel: shortLabelFor(o.directionType),
    displayOrder: i,
  }));

  if (types.has("left") && types.has("right") && types.has("straight")) {
    return {
      title: `Which way will ${characterName} go?`,
      subtitle: transportMode === "walking" ? "On foot" : transportMode,
      marketType: "next_direction",
      options: optionRows,
    };
  }

  if (types.has("left") && types.has("right")) {
    return {
      title: `Left or right for ${characterName}?`,
      marketType: "left_right_split",
      options: optionRows,
    };
  }

  if (types.has("enter") && types.has("continue")) {
    return {
      title: `Will ${characterName} enter, or keep going?`,
      marketType: "entry_vs_skip",
      options: optionRows,
    };
  }

  if (types.has("stop") && types.has("continue")) {
    return {
      title: `Will ${characterName} stop or continue?`,
      marketType: "next_stop",
      options: optionRows,
    };
  }

  return {
    title: `${characterName}'s next move`,
    marketType: "continue_vs_turn",
    options: optionRows,
  };
}

function shortLabelFor(dir: RouteDecisionOption["directionType"]): string {
  switch (dir) {
    case "left":
      return "Left";
    case "right":
      return "Right";
    case "straight":
      return "Straight";
    case "enter":
      return "Enter";
    case "continue":
      return "Keep going";
    case "stop":
      return "Stop";
    case "turn_back":
      return "Turn back";
    case "lane_choice":
      return "Lane";
    case "destination_choice":
      return "Destination";
    default:
      return "Option";
  }
}
