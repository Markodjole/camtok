-- Store the real GPS turn point (projected at market creation time from live GPS) on each market.
-- This lets the streamer map show the exact intersection the AI decided on.
ALTER TABLE live_betting_markets
  ADD COLUMN IF NOT EXISTS turn_point_lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS turn_point_lng DOUBLE PRECISION;

COMMENT ON COLUMN live_betting_markets.turn_point_lat
  IS 'Estimated GPS lat of the upcoming turn/decision point, projected at market open time.';
COMMENT ON COLUMN live_betting_markets.turn_point_lng
  IS 'Estimated GPS lng of the upcoming turn/decision point, projected at market open time.';
