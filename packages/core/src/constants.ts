export const APP_NAME = "Crosstown";
export const APP_DESCRIPTION = "Watch the drive. Call the next move.";

export const DEMO_WALLET_INITIAL_BALANCE = 1000;

export const BET_LIMITS = {
  MIN_STAKE: 1,
  MAX_STAKE: 10000,
  MAX_OPEN_BETS_PER_CLIP: 5,
} as const;

export const CLIP_LIMITS = {
  MIN_DURATION_MS: 5000,
  MAX_DURATION_MS: 60000,
  MAX_FILE_SIZE_MB: 100,
  ACCEPTED_FORMATS: ["video/mp4", "video/webm", "video/quicktime"],
} as const;

export const PREDICTION_LIMITS = {
  MIN_LENGTH: 3,
  MAX_LENGTH: 300,
  MAX_PER_CLIP: 50,
  MAX_PER_USER_PER_CLIP: 3,
} as const;

// Temporary: 72h for testing (was 5 min)
export const BETTING_WINDOW_MS = 72 * 60 * 60 * 1000;

export const SETTLEMENT_ALGORITHM_VERSION = "v1.0.0";
export const ODDS_ALGORITHM_VERSION = "v1.0.0";
export const NORMALIZATION_SCHEMA_VERSION = 1;

export const PAGINATION = {
  DEFAULT_PAGE_SIZE: 20,
  MAX_PAGE_SIZE: 100,
} as const;
