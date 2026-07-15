-- Rush Hour–style vehicle count round (bet → 30s count window → settle).

ALTER TYPE live_market_type ADD VALUE IF NOT EXISTS 'vehicle_count_30s';

ALTER TABLE character_lead_vehicle_state
  ADD COLUMN IF NOT EXISTS count_round_id text,
  ADD COLUMN IF NOT EXISTS count_round_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS count_round_counting boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS count_round_final boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS count_round_updated_at timestamptz;
