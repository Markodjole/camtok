import type { BetTypeV2 } from "@bettok/live";

/** Short product labels for engine pills and sheet titles. */
const LABELS: Record<BetTypeV2, string> = {
  next_turn: "Next junction",
  next_zone: "Next grid square",
  zone_exit_time: "Time to exit zone",
};

export function betTypeV2Label(type: BetTypeV2): string {
  return LABELS[type] ?? type;
}

/** Full sheet / CTA line, e.g. "Next turn bet". */
export function engineBetHeadline(type: BetTypeV2): string {
  return `${betTypeV2Label(type)} bet`;
}
