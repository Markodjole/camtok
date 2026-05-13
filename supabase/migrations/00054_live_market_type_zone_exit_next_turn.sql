-- Add the two market types used by the live betting system.
-- city_grid was already added in 00046; zone_exit_time and next_turn were missing.
ALTER TYPE live_market_type ADD VALUE IF NOT EXISTS 'zone_exit_time';
ALTER TYPE live_market_type ADD VALUE IF NOT EXISTS 'next_turn';
