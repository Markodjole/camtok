/**
 * Generic fallback: straight-line distance (meters) from the vehicle to a
 * stored `turn_point_lat/lng` at which betting must close.  Used only for
 * market types that record a turn point but are not `next_turn` itself.
 */
export const LIVE_BET_LOCK_DISTANCE_M = 50;

/**
 * Distance (meters) from the next routing pin at which a `next_turn` market
 * locks for new bets.  Must be:
 *   • Smaller than NEXT_TURN_PIN_MIN_M (100 m) so there is betting runway.
 *   • Larger than NEXT_TURN_QUEUED_OPEN_MIN_M (65 m) — used in the opener
 *     to reject queued opens that are already within this band.
 *   • Referenced by both server (placeLiveBet) and client (LiveRoomScreen)
 *     so the lock fires at exactly the same moment everywhere.
 */
export const NEXT_TURN_BET_LOCK_DISTANCE_M = 40;
