import type { BetTypeV2 } from "@bettok/live";

const LABELS: Record<BetTypeV2, string> = {
  next_turn: "Next turn",
  next_zone: "Next zone",
  zone_exit_time: "Exit zone timing",
  zone_duration: "Zone duration",
  time_vs_google: "Beat Google ETA",
  stop_count: "Stop count",
  turns_before_zone_exit: "Turns before exit",
  turn_count_to_pin: "Turns to pin",
  eta_drift: "ETA drift",
};

export function betTypeV2Label(type: BetTypeV2): string {
  return LABELS[type] ?? type;
}
