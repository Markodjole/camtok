-- Lead-vehicle telemetry + overtake_30s prediction market.
--
-- Mobile posts events to POST /api/live/sessions/:id/lead-vehicle-events.
-- Engine opens yes/no markets when prediction_ready is true.

ALTER TYPE live_market_type ADD VALUE IF NOT EXISTS 'overtake_30s';

CREATE TABLE IF NOT EXISTS lead_vehicle_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  live_session_id uuid NOT NULL REFERENCES character_live_sessions(id) on DELETE CASCADE,
  room_id uuid REFERENCES live_rooms(id) ON DELETE SET NULL,
  owner_user_id uuid NOT NULL,
  event_type text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  client_timestamp_ms bigint,
  track_id text,
  vehicle_type text,
  confidence double precision,
  same_direction_confidence double precision,
  relative_state text,
  visible_duration_ms integer,
  lateral_position text,
  prediction_ready boolean,
  prediction_confidence double precision,
  normalized_bbox jsonb,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  model_name text,
  model_version text,
  inference_mode text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lead_vehicle_events_session_recorded_idx
  ON lead_vehicle_events (live_session_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS lead_vehicle_events_session_type_idx
  ON lead_vehicle_events (live_session_id, event_type, recorded_at DESC);

-- Latest lead-vehicle snapshot per session (tick reads this).
CREATE TABLE IF NOT EXISTS character_lead_vehicle_state (
  live_session_id uuid PRIMARY KEY REFERENCES character_live_sessions(id) ON DELETE CASCADE,
  character_id uuid,
  room_id uuid,
  track_id text,
  vehicle_type text,
  confidence double precision,
  same_direction_confidence double precision,
  relative_state text,
  visible_duration_ms integer,
  lateral_position text,
  prediction_ready boolean NOT NULL DEFAULT false,
  prediction_confidence double precision,
  prediction_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  prediction_blockers jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_event_type text,
  last_event_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE lead_vehicle_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE character_lead_vehicle_state ENABLE ROW LEVEL SECURITY;

-- No anon/authenticated policies: writes go through the Next.js service role
-- (bypasses RLS). Mobile never talks to these tables directly.
