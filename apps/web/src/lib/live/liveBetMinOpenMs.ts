/** Never lock a market or treat betting as closed until this long after `opens_at`. */
export const MIN_MARKET_OPEN_MS_BEFORE_LOCK = 4_000;

/**
 * Minimum gap between consecutive system markets in the same room. We keep this
 * small so a fresh bet appears almost immediately after the previous one settles
 * — the per-market `MIN_MARKET_OPEN_MS_BEFORE_LOCK` window already guarantees
 * each bet stays on screen ≥ 4 s before it can be locked.
 */
export const MIN_MS_BETWEEN_SYSTEM_MARKETS = 500;

/** Hold the viewer pill/popup at least this long before switching to a new bet type. */
export const VIEWER_BET_MIN_DISPLAY_MS = 4_000;
