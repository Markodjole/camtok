import type { BetTypeV2 } from "@bettok/live";

/** Short product labels for engine pills and sheet titles (not internal ids). */
const LABELS: Record<BetTypeV2, string> = {
  next_turn: "Next turn",
  next_zone: "Pick next zone",
  zone_exit_time: "Time to leave zone",
  zone_duration: "Zone hangtime",
  time_vs_google: "Beat Google",
  stop_count: "How many stops?",
  turns_before_zone_exit: "Turns before exit",
  turn_count_to_pin: "Turns to next pin",
  eta_drift: "ETA drift",
};

export function betTypeV2Label(type: BetTypeV2): string {
  return LABELS[type] ?? type;
}

/** Full sheet / CTA line, e.g. "Next turn bet". */
export function engineBetHeadline(type: BetTypeV2): string {
  return `${betTypeV2Label(type)} bet`;
}
