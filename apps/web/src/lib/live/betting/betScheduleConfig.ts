import {
  NEXT_STEP_MIN_ROAD_M,
  NEXT_STEP_FILLER_MAX_ROAD_M,
} from "@/lib/live/betting/betWindowConstants";

/**
 * Bet scheduling configuration.
 *
 * Controls two distinct concerns:
 *
 *   1. PRIORITY — when multiple triggers are eligible simultaneously, the
 *      lower priority number opens first.  The queue is always drained in
 *      priority order.
 *
 *   2. FILLER — types with `isFiller: true` are used to eliminate dead air
 *      when no context-dependent bet is ready.  They operate with a wider
 *      trigger window (`fillerMinM` / `fillerMaxM`) so there is almost always
 *      a candidate.  Currently only `next_step` is a filler.
 *
 * ─── Contextual ordering rationale ──────────────────────────────────────────
 *
 *   1. zone_exit_time — must open on the exact zone entry / center / exit
 *      transition; the most timing-sensitive trigger.
 *
 *   2. next_turn — driver is approaching a physical crossroad pin (100–220 m),
 *      very time-sensitive; skipped if driver passes the pin before market opens.
 *
 *   3. next_step — OSRM maneuver-point bet, primary gap-filler.  Normal window
 *      (150–500 m) works as a regular trigger; wide filler window (80–1200 m)
 *      ensures it can always fill spare time between other bets.
 *
 *   4. straight_streak — detected ahead on the planning route, not
 *      time-critical (fires well before the driver reaches the crossroads).
 *
 *   5. city_grid / next_zone — "pick the next square" informational bet,
 *      least time-sensitive; typically queued after zone_exit_time settles.
 *
 * ─── Zone flow ───────────────────────────────────────────────────────────────
 *
 *   Zone entry:  zone_exit_time (entry) only — city_grid waits 12 s dwell + idle
 *                (see betOpenPolicy.ts).
 *   Zone center: zone_exit_time (center_70m) — opens or queues per policy.
 *   Zone exit:   zone_exit_time (exit_outer) — opens or queues.
 *   Gaps:        next_step filler when policy allows (5 s min gap, one popup max).
 */

export type BetScheduleEntry = {
  /** Matches a value in the live_market_type enum. */
  marketType: string;
  /**
   * Sort key when multiple triggers are eligible at the same time.
   * Lower = opens first.  Zone_exit_time sub-phases use fractional offsets
   * (entry=+0, center_70m=+0.1, exit_outer=+0.2) applied at call-site.
   */
  priority: number;
  /**
   * When true this type is used as a gap-filler: opens whenever the room is
   * idle AND no non-filler bet is available.  Uses `fillerMinM`/`fillerMaxM`
   * instead of the normal betWindowConstants trigger window.
   */
  isFiller: boolean;
  /** Relaxed minimum distance (m) when running as a filler. */
  fillerMinM?: number;
  /** Relaxed maximum distance (m) when running as a filler. */
  fillerMaxM?: number;
  /** Human-readable description of when and why this bet type triggers. */
  description: string;
};

export const BET_SCHEDULE: BetScheduleEntry[] = [
  {
    marketType: "zone_exit_time",
    priority: 1,
    isFiller: false,
    description:
      "Time to exit grid zone — fires on zone entry, center-pass (≤70 m from centre), " +
      "and outer-exit (≥100 m after centre).  Up to 3× per cell.",
  },
  {
    marketType: "next_turn",
    priority: 2,
    isFiller: false,
    description:
      "Turn direction at next OSM crossroad pin — fires when the pin is 100–220 m " +
      "ahead and within the driver's forward cone.  Skipped if driver is already " +
      "within NEXT_TURN_QUEUED_OPEN_MIN_M when the queued market tries to open.",
  },
  {
    marketType: "next_step",
    priority: 3,
    isFiller: true,
    fillerMinM: NEXT_STEP_MIN_ROAD_M,
    fillerMaxM: NEXT_STEP_FILLER_MAX_ROAD_M,
    description:
      "Time to next OSRM maneuver — primary gap-filler.  Fires whenever an OSRM " +
      "step maneuver point lies on the Google planning polyline. " +
      "Normal trigger window: 150–500 m. " +
      "Filler window: 80–1200 m for near-100 % coverage between other bets.",
  },
  {
    marketType: "straight_streak",
    priority: 4,
    isFiller: false,
    description:
      "Consecutive straight-through intersections — fires when the planning route " +
      "shows ≥2 straights ahead. Settles on first real turn or after 3 intersections.",
  },
  {
    marketType: "city_grid",
    priority: 5,
    isFiller: false,
    description:
      "Pick the next 500 m grid square — fires once per cell after 12 s dwell " +
      "with no other popup on screen (see betOpenPolicy.ts).",
  },
];

/** Priority for a market type.  Falls back to 99 for unknown types. */
export function betSchedulePriority(marketType: string): number {
  return BET_SCHEDULE.find((e) => e.marketType === marketType)?.priority ?? 99;
}

/** All entries configured as gap-fillers, in priority order. */
export function getFillerEntries(): BetScheduleEntry[] {
  return BET_SCHEDULE.filter((e) => e.isFiller).sort((a, b) => a.priority - b.priority);
}
