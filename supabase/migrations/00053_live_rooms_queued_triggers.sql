-- Stores a FIFO list of bet triggers that fired while a market was already
-- open. Each entry is a JSON object describing the trigger; the tick worker
-- pops them in order so no eligible bet is ever skipped.
--
-- Schema per entry (one of):
--   { "type": "next_turn",     "pinKey": "pin:42", "pinId": 42, "pinLat": 0.0, "pinLng": 0.0,   "queuedAt": <epochMs> }
--   { "type": "next_zone",     "cellKey": "cell:r5:c3",                                           "queuedAt": <epochMs> }
--   { "type": "zone_exit_time","phase": "entry"|"center_70m"|"exit_outer", "cellKey": "cell:r5:c3", "capturedZone": "...", "queuedAt": <epochMs> }
ALTER TABLE live_rooms
  ADD COLUMN IF NOT EXISTS queued_triggers jsonb NOT NULL DEFAULT '[]'::jsonb;
