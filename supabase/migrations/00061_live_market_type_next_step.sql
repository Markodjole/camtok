-- Add `next_step` to the live_market_type enum.
--
-- next_step: bet on how long it takes the driver to reach the next OSRM
-- step maneuver point (turn, continue, roundabout, etc.) that lies on the
-- same planned road path as the Google Maps route.  Bet options are
-- step_under / step_at / step_over relative to the Google-projected ETA.

ALTER TYPE live_market_type ADD VALUE IF NOT EXISTS 'next_step';
