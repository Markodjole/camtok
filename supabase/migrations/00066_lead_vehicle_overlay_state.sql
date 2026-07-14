-- Lead-vehicle viewer overlay fields on the latest session snapshot.

ALTER TABLE character_lead_vehicle_state
  ADD COLUMN IF NOT EXISTS normalized_bbox jsonb,
  ADD COLUMN IF NOT EXISTS overlay_detections jsonb NOT NULL DEFAULT '[]'::jsonb;
