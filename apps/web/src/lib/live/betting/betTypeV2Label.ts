import type { BetTypeV2 } from "@bettok/live";

/** Short product labels for engine pills and sheet titles (not internal ids). */
const LABELS: Record<BetTypeV2, string> = {
  next_turn: "Next junction",
  next_zone: "Next grid square",
  zone_exit_time: "Time to exit zone",
  zone_duration: "Time in zone",
  time_vs_google: "ETA vs Google",
  stop_count: "Stops this zone",
  turns_before_zone_exit: "Turns before exit",
  turn_count_to_pin: "Turns to pin",
  eta_drift: "ETA moves",
};

export function betTypeV2Label(type: BetTypeV2): string {
  return LABELS[type] ?? type;
}

/** Full sheet / CTA line, e.g. "Next turn bet". */
export function engineBetHeadline(type: BetTypeV2): string {
  return `${betTypeV2Label(type)} bet`;
}
