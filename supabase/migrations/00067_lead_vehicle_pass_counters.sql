-- Pass / on-screen vehicle counters for live viewer HUD.

ALTER TABLE character_lead_vehicle_state
  ADD COLUMN IF NOT EXISTS vehicles_on_screen integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS vehicles_passed integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_pass jsonb;
