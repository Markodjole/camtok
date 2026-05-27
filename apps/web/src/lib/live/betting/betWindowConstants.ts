/**
 * Bet timing and spatial trigger thresholds.
 *
 * These are the ONLY conditions that control when a market opens, when the
 * viewer sees a popup, and when betting is unlocked.
 *
 * Product rules:
 *  - next_zone       → fires ONCE per zone cell when driver ≤ 100 m from cell center
 *  - zone_exit_time  → fires up to 3× per zone:
 *                       1) on zone entry (driver inside the cell)
 *                       2) when driver ≤ 70 m from cell center
 *                       3) when driver ≥ 100 m from center after having been within 70 m
 *  - next_turn       → fires once per pin when driver is within [90 m, 150 m] of next pin
 *                       (120 m nominal ± 30 m tolerance)
 *  - If a trigger fires while a bet is already showing, it is queued and
 *    opens immediately when the screen clears (see tick route).
 */

/**
 * Bet popup minimum display time. Every market stays open for at least this long.
 * When the queue is empty the opener extends to BET_OPEN_WINDOW_IDLE_MS instead.
 */
export const BET_OPEN_WINDOW_MS = 8_000;

/**
 * Extended window used when there are no queued triggers waiting — viewer gets
 * the full 12 seconds to decide.
 */
export const BET_OPEN_WINDOW_IDLE_MS = 12_000;

// ─── next_zone ────────────────────────────────────────────────────────────────

/** Open next_zone when driver is within this distance of current cell center (m). */
export const NEXT_ZONE_TRIGGER_M = 100;

// ─── zone_exit_time ───────────────────────────────────────────────────────────

/** Phase 2: open when driver ≤ this distance from cell center (m). */
export const ZONE_EXIT_CENTER_TRIGGER_M = 70;

/**
 * Phase 3 min distance: open when driver ≥ this far from cell center AND
 * phase 2 has already fired (driver was close to center, now moving outward).
 */
export const ZONE_EXIT_OUTER_TRIGGER_MIN_M = 100;

// ─── next_turn ────────────────────────────────────────────────────────────────
//
// Trigger band: wider than the old 90–150 m to give viewers enough runway
// between market-open and the distance lock (NEXT_TURN_BET_LOCK_DISTANCE_M).
//
// At 30 km/h the driver covers ~8.3 m/s.  With the old 90 m min and 70 m lock
// there were only 20 m of bettable window (≈ 2.4 s after grace).  The new band
// (100–220 m) plus a 40 m lock leaves 60+ m of runway (≥ 7 s at 30 km/h).
//
// Queued-open safety: when a trigger fires at 100–220 m but the market is
// queued (another market is open), the driver continues moving.  By the time
// the queue drains the driver may already be within the lock threshold.
// NEXT_TURN_QUEUED_OPEN_MIN_M is the minimum distance that must remain at the
// moment the queued market actually opens; if the driver is already closer,
// the opener is skipped to avoid a market that locks immediately.

/** Nominal distance at which next_turn triggers (m). */
export const NEXT_TURN_PIN_TARGET_M = 160;

/** Window around the nominal distance: trigger fires while dist is in [MIN, MAX]. */
export const NEXT_TURN_PIN_MIN_M = 100;
export const NEXT_TURN_PIN_MAX_M = 220;

/**
 * Minimum distance from the turn pin at which a *queued* next_turn open is
 * allowed to proceed.  Must be noticeably larger than NEXT_TURN_BET_LOCK_DISTANCE_M
 * so users always have at least a few seconds to bet once the market opens.
 */
export const NEXT_TURN_QUEUED_OPEN_MIN_M = 65;

// ─── straight_streak ──────────────────────────────────────────────────────────
//
// A market that asks: "how many consecutive straight-through intersections
// will the driver take before turning?"
//
//   TRIGGER: detected when the planning route shows ≥ STRAIGHT_STREAK_MIN_LENGTH
//            consecutive crossroads with bearing change < STRAIGHT_THRESHOLD_DEG.
//   OPTIONS: < N  /  = N (±1)  /  > N  where N = expected streak at open time.
//   SETTLE:  when GPS heading change since opens_at exceeds
//            STRAIGHT_STREAK_COMMITTED_TURN_DEG, or reveal_at safety fires.

/** Minimum expected straight count for a market to open (must be interesting). */
export const STRAIGHT_STREAK_MIN_LENGTH = 2;

/**
 * A crossroad is classified as "straight" on the planned route when the
 * bearing change of the polyline at that point is below this threshold.
 */
export const STRAIGHT_THRESHOLD_DEG = 25;

/**
 * Proximity radius (meters) used by the resolver to decide whether a GPS
 * snapshot is "at" a stored intersection.
 */
export const STREAK_CROSSROAD_PROXIMITY_M = 45;

/**
 * Heading-change threshold (degrees, first→last GPS since opens_at) at which
 * the sweep decides the driver has committed to a turn and settlement is ready.
 * Larger than STRAIGHT_THRESHOLD_DEG to avoid early settle on GPS noise.
 */
export const STRAIGHT_STREAK_COMMITTED_TURN_DEG = 40;

/**
 * Number of intersections the driver must physically pass through for the
 * `intersections_passed` resolution condition to fire on a `straight_streak`
 * market.  Whichever arrives first — this count OR a heading change ≥
 * STRAIGHT_STREAK_COMMITTED_TURN_DEG — triggers settlement.
 *
 * Set to 3 so that even when the driver goes dead-straight through every
 * crossroad (heading delta stays near 0°) the market still resolves after
 * the third intersection rather than waiting for the reveal_at safety cap.
 */
export const STRAIGHT_STREAK_INTERSECTIONS_TO_RESOLVE = 3;

// ─── Client-bet-at timing tolerance ──────────────────────────────────────────
//
// When the client sends `clientBetAt` (the epoch ms when the user tapped),
// the server honours it if it passes two sanity checks:
//
//   1. Not in the future by more than CLOCK_SKEW_TOLERANCE_MS  (guards against
//      client clocks that run fast or outright manipulation).
//   2. Not more than CLIENT_BET_AT_MAX_LATENCY_MS in the past relative to the
//      server clock (guards against replays and unreasonably slow requests).
//
// A bet whose *effective* time (min of server clock and valid clientBetAt) is
// before locks_at is accepted even if the market has already transitioned to
// "locked" by the time the request lands — this is the normal network-latency
// race condition.

/** Maximum tolerated forward clock skew on the client (ms). */
export const CLOCK_SKEW_TOLERANCE_MS = 3_000;

/**
 * Maximum age of a clientBetAt value relative to the server clock (ms).
 * Requests older than this are treated as if clientBetAt was not provided.
 */
export const CLIENT_BET_AT_MAX_LATENCY_MS = 8_000;

// ─── Legacy alias (used in live-markets.ts client-side lock check) ────────────

/** @deprecated use NEXT_ZONE_TRIGGER_M */
export const ZONE_BET_CENTER_RADIUS_M = NEXT_ZONE_TRIGGER_M;
