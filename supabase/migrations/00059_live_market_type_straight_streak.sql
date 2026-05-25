-- Add straight_streak to the live_market_type enum so the straight-streak
-- bet opener can insert rows without a Postgres invalid-enum-value error.
ALTER TYPE live_market_type ADD VALUE IF NOT EXISTS 'straight_streak';
