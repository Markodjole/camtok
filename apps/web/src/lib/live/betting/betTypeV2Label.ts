import type { BetTypeV2 } from "@bettok/live";

/** Short product labels for engine pills and sheet titles (not internal ids). */
const LABELS: Record<BetTypeV2, string> = {
  next_turn: "Next turn",
  next_zone: "Next area",
  zone_exit_time: "Zone exit",
  zone_duration: "Zone hangtime",
  time_vs_google: "Beat time",
  stop_count: "Count stops",
  turns_before_zone_exit: "Turns to boundary",
  turn_count_to_pin: "Turns ahead",
  eta_drift: "ETA drift",
};

export function betTypeV2Label(type: BetTypeV2): string {
  return LABELS[type] ?? type;
}

/** Full sheet / CTA line, e.g. "Next turn bet". */
export function engineBetHeadline(type: BetTypeV2): string {
  return `${betTypeV2Label(type)} bet`;
}
