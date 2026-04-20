-- =========================================================
-- Camtok character entity model (post-BetTok evolution)
-- =========================================================
-- Goal:
--   Keep "character" as the anchor object, but model it as:
--   narrative profile + live tracked entity + decision history + betting object
--   with explicit auditability and safety controls.
--
-- This migration is additive and backwards compatible.

-- ─── Core identity upgrades on characters ─────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'camtok_entity_type'
  ) THEN
    CREATE TYPE camtok_entity_type AS ENUM ('pedestrian', 'bike', 'car', 'other');
  END IF;
END $$;

ALTER TABLE characters
  ADD COLUMN IF NOT EXISTS camtok_entity_type camtok_entity_type NOT NULL DEFAULT 'pedestrian',
  ADD COLUMN IF NOT EXISTS operator_user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS camtok_active BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS camtok_content JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_characters_camtok_entity_type ON characters(camtok_entity_type);
CREATE INDEX IF NOT EXISTS idx_characters_operator_user ON characters(operator_user_id);

COMMENT ON COLUMN characters.camtok_content IS
  'Content/personality layer for Camtok (bio, tags, city/zone, preferred hours, recurring story arcs).';

-- ─── Live technical state (latest state per character) ───
CREATE TABLE IF NOT EXISTS character_live_telemetry_state (
  character_id UUID PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  live_session_id UUID REFERENCES character_live_sessions(id) ON DELETE SET NULL,
  current_lat DOUBLE PRECISION,
  current_lng DOUBLE PRECISION,
  heading_deg REAL,
  speed_mps REAL,
  altitude_meters REAL,
  gps_accuracy_meters REAL,
  gps_confidence_score REAL CHECK (
    gps_confidence_score IS NULL OR (gps_confidence_score >= 0 AND gps_confidence_score <= 1)
  ),
  battery_percent REAL CHECK (battery_percent IS NULL OR (battery_percent >= 0 AND battery_percent <= 100)),
  battery_charging BOOLEAN,
  network_quality_score REAL CHECK (
    network_quality_score IS NULL OR (network_quality_score >= 0 AND network_quality_score <= 1)
  ),
  stream_status TEXT,
  camera_sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_character_telemetry_session ON character_live_telemetry_state(live_session_id);

-- ─── Route/game state (latest state per character) ───────
CREATE TABLE IF NOT EXISTS character_route_game_state (
  character_id UUID PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  live_session_id UUID REFERENCES character_live_sessions(id) ON DELETE SET NULL,
  current_segment_id TEXT,
  snapped_node_id TEXT,
  snapped_edge_id TEXT,
  next_valid_moves JSONB NOT NULL DEFAULT '[]'::jsonb,
  locked_move_option_id TEXT,
  locked_at TIMESTAMPTZ,
  lock_expires_at TIMESTAMPTZ,
  missed_turn BOOLEAN NOT NULL DEFAULT false,
  mission_label TEXT,
  mission_destination JSONB,
  mission_progress_score REAL CHECK (
    mission_progress_score IS NULL OR (mission_progress_score >= 0 AND mission_progress_score <= 1)
  ),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_character_route_state_session ON character_route_game_state(live_session_id);
CREATE INDEX IF NOT EXISTS idx_character_route_state_locked_at ON character_route_game_state(locked_at DESC);

-- ─── Behavioral profile (learnable tendencies) ───────────
CREATE TABLE IF NOT EXISTS character_behavior_profiles (
  character_id UUID PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  risk_level_score REAL CHECK (risk_level_score IS NULL OR (risk_level_score >= 0 AND risk_level_score <= 1)),
  prefers_main_roads_score REAL CHECK (
    prefers_main_roads_score IS NULL OR (prefers_main_roads_score >= 0 AND prefers_main_roads_score <= 1)
  ),
  speed_style_score REAL CHECK (speed_style_score IS NULL OR (speed_style_score >= 0 AND speed_style_score <= 1)),
  hesitation_tendency_score REAL CHECK (
    hesitation_tendency_score IS NULL OR (hesitation_tendency_score >= 0 AND hesitation_tendency_score <= 1)
  ),
  safest_route_bias_score REAL CHECK (
    safest_route_bias_score IS NULL OR (safest_route_bias_score >= 0 AND safest_route_bias_score <= 1)
  ),
  exploration_bias_score REAL CHECK (
    exploration_bias_score IS NULL OR (exploration_bias_score >= 0 AND exploration_bias_score <= 1)
  ),
  learned_model_version TEXT,
  history_window_size INT NOT NULL DEFAULT 50,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Public game stats (comparability/retention) ─────────
CREATE TABLE IF NOT EXISTS character_public_game_stats (
  character_id UUID PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  total_runs INT NOT NULL DEFAULT 0,
  completed_runs INT NOT NULL DEFAULT 0,
  avg_run_duration_seconds REAL,
  avg_completion_seconds REAL,
  avg_speed_mps REAL,
  crowd_prediction_accuracy REAL CHECK (
    crowd_prediction_accuracy IS NULL OR (crowd_prediction_accuracy >= 0 AND crowd_prediction_accuracy <= 1)
  ),
  volatility_score REAL CHECK (volatility_score IS NULL OR (volatility_score >= 0 AND volatility_score <= 1)),
  favorite_turn_tendencies JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Trust / audit decision history (append-only) ────────
CREATE TABLE IF NOT EXISTS character_decision_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  live_session_id UUID REFERENCES character_live_sessions(id) ON DELETE SET NULL,
  market_id UUID REFERENCES live_betting_markets(id) ON DELETE SET NULL,
  decision_node_id UUID REFERENCES route_decision_nodes(id) ON DELETE SET NULL,
  route_snapshot_id UUID REFERENCES live_route_snapshots(id) ON DELETE SET NULL,
  lock_timestamp TIMESTAMPTZ,
  reveal_timestamp TIMESTAMPTZ,
  commit_hash TEXT,
  state_snapshot_hash TEXT,
  operator_intervention_flag BOOLEAN NOT NULL DEFAULT false,
  gps_confidence_score REAL CHECK (
    gps_confidence_score IS NULL OR (gps_confidence_score >= 0 AND gps_confidence_score <= 1)
  ),
  anomaly_flags TEXT[] NOT NULL DEFAULT '{}',
  evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_char_decision_audit_char_time
  ON character_decision_audit_log(character_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_char_decision_audit_session
  ON character_decision_audit_log(live_session_id, created_at DESC);

-- ─── Safety / compliance profile ─────────────────────────
CREATE TABLE IF NOT EXISTS character_safety_profiles (
  character_id UUID PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  allowed_zones JSONB NOT NULL DEFAULT '[]'::jsonb,
  forbidden_zones JSONB NOT NULL DEFAULT '[]'::jsonb,
  maximum_mission_radius_meters REAL,
  emergency_stop_state BOOLEAN NOT NULL DEFAULT false,
  moderation_flags TEXT[] NOT NULL DEFAULT '{}',
  operator_identity_verified BOOLEAN NOT NULL DEFAULT false,
  stream_safety_incidents_count INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── RLS for new Camtok tables ───────────────────────────
ALTER TABLE character_live_telemetry_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE character_route_game_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE character_behavior_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE character_public_game_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE character_decision_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE character_safety_profiles ENABLE ROW LEVEL SECURITY;

-- Public read surfaces (spectator confidence and discovery)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'character_public_game_stats' AND policyname = 'character_public_stats_read'
  ) THEN
    CREATE POLICY "character_public_stats_read"
      ON character_public_game_stats FOR SELECT USING (TRUE);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'character_decision_audit_log' AND policyname = 'character_audit_public_read'
  ) THEN
    CREATE POLICY "character_audit_public_read"
      ON character_decision_audit_log FOR SELECT USING (TRUE);
  END IF;
END $$;

-- Owner/operator readable operational tables.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'character_live_telemetry_state' AND policyname = 'character_live_telemetry_owner_read'
  ) THEN
    CREATE POLICY "character_live_telemetry_owner_read"
      ON character_live_telemetry_state FOR SELECT
      USING (
        EXISTS (
          SELECT 1
          FROM characters c
          WHERE c.id = character_live_telemetry_state.character_id
            AND (c.creator_user_id = auth.uid() OR c.operator_user_id = auth.uid())
        )
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'character_route_game_state' AND policyname = 'character_route_state_owner_read'
  ) THEN
    CREATE POLICY "character_route_state_owner_read"
      ON character_route_game_state FOR SELECT
      USING (
        EXISTS (
          SELECT 1
          FROM characters c
          WHERE c.id = character_route_game_state.character_id
            AND (c.creator_user_id = auth.uid() OR c.operator_user_id = auth.uid())
        )
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'character_behavior_profiles' AND policyname = 'character_behavior_public_read'
  ) THEN
    CREATE POLICY "character_behavior_public_read"
      ON character_behavior_profiles FOR SELECT USING (TRUE);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'character_safety_profiles' AND policyname = 'character_safety_owner_read'
  ) THEN
    CREATE POLICY "character_safety_owner_read"
      ON character_safety_profiles FOR SELECT
      USING (
        EXISTS (
          SELECT 1
          FROM characters c
          WHERE c.id = character_safety_profiles.character_id
            AND (c.creator_user_id = auth.uid() OR c.operator_user_id = auth.uid())
        )
      );
  END IF;
END $$;

-- Server-side writes only (service role). No INSERT/UPDATE/DELETE policies.
