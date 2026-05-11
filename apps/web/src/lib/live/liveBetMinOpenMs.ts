/** Never lock a market or treat betting as closed until this long after `opens_at`. */
export const MIN_MARKET_OPEN_MS_BEFORE_LOCK = 4_000;

/** Minimum gap before opening another system market in the same room (viewer headline churn). */
export const MIN_MS_BETWEEN_SYSTEM_MARKETS = 4_000;
