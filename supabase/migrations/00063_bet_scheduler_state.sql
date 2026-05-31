-- Per-room bet scheduler state: cell dwell timing, last popup open time.
ALTER TABLE live_rooms
  ADD COLUMN IF NOT EXISTS bet_scheduler_state jsonb NOT NULL DEFAULT '{}'::jsonb;
