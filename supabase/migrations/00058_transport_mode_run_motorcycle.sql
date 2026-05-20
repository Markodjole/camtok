-- Add transport modes used by camtokmobile that were missing from the server enum.
-- 'run' (running), 'motorcycle', 'other' (maps to the catch-all case).

ALTER TYPE live_transport_mode ADD VALUE IF NOT EXISTS 'run';
ALTER TYPE live_transport_mode ADD VALUE IF NOT EXISTS 'motorcycle';
ALTER TYPE live_transport_mode ADD VALUE IF NOT EXISTS 'other';
