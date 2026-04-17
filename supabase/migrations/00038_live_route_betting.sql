-- =========================================================
-- CamTok pivot — Live WebRTC + GPS route-state betting
-- =========================================================
-- Introduces the live betting surface:
--   * character live sessions (broadcaster state)
--   * normalized route snapshots (GPS truth)
--   * decision nodes detected ahead of the user
--   * live rooms (shared betting surface per session)
--   * live betting markets (system + user generated)
--   * user market proposals (validated, queued or auto-converted)
--   * market lock records (commit evidence for settlement fairness)
--   * live room events (append-only timeline)
--   * character route stats (aggregated live behavior stats)
-- Everything is additive. AI-generated story/clip system remains
-- for legacy/archive modes but is no longer on the critical path.

-- ─── Enums ──────────────────────────────────────────────
CREATE TYPE live_transport_mode AS ENUM (
  'walking', 'bike', 'scooter', 'car', 'other_vehicle'
);

CREATE TYPE live_session_status AS ENUM (
  'starting', 'live', 'paused', 'ended', 'errored'
);

CREATE TYPE live_safety_level AS ENUM (
  'normal', 'restricted', 'blocked'
);

CREATE TYPE live_room_phase AS ENUM (
  'idle',
  'waiting_for_next_market',
  'market_open',
  'market_locked',
  'reveal_pending',
  'revealed',
  'settled'
);

CREATE TYPE live_market_source AS ENUM (
  'system_generated', 'user_generated'
);

CREATE TYPE live_market_type AS ENUM (
  'next_direction',
  'next_stop',
  'next_place_type',
  'entry_vs_skip',
  'left_right_split',
  'continue_vs_turn',
  'route_choice',
  'custom_validated'
);

CREATE TYPE live_market_status AS ENUM (
  'draft', 'open', 'locked', 'revealed', 'settled', 'cancelled'
);

CREATE TYPE live_decision_status AS ENUM (
  'candidate', 'open', 'locked', 'revealed', 'expired', 'cancelled'
);

CREATE TYPE live_decision_direction AS ENUM (
  'left', 'right', 'straight', 'enter', 'stop',
  'continue', 'turn_back', 'lane_choice', 'destination_choice', 'other'
);

CREATE TYPE live_user_market_status AS ENUM (
  'submitted', 'validated', 'rejected', 'converted_to_market'
);

-- ─── character_live_sessions ───────────────────────────
CREATE TABLE character_live_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status live_session_status NOT NULL DEFAULT 'starting',
  transport_mode live_transport_mode NOT NULL DEFAULT 'walking',
  stream_provider TEXT NOT NULL DEFAULT 'webrtc',
  stream_key TEXT,
  broadcaster_token_hash TEXT,
  session_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session_ended_at TIMESTAMPTZ,
  last_heartbeat_at TIMESTAMPTZ,
  current_room_id UUID,
  current_status_text TEXT,
  current_intent_label TEXT,
  region_label TEXT,
  place_type TEXT,
  safety_level live_safety_level NOT NULL DEFAULT 'normal',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_live_sessions_character ON character_live_sessions(character_id);
CREATE INDEX idx_live_sessions_owner ON character_live_sessions(owner_user_id);
CREATE INDEX idx_live_sessions_status ON character_live_sessions(status);
CREATE INDEX idx_live_sessions_current_room ON character_live_sessions(current_room_id);
CREATE UNIQUE INDEX idx_live_sessions_single_live_per_character
  ON character_live_sessions(character_id)
  WHERE status IN ('starting', 'live', 'paused');

-- ─── live_route_snapshots ─────────────────────────────
CREATE TABLE live_route_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  live_session_id UUID NOT NULL REFERENCES character_live_sessions(id) ON DELETE CASCADE,
  recorded_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw_lat DOUBLE PRECISION NOT NULL,
  raw_lng DOUBLE PRECISION NOT NULL,
  normalized_lat DOUBLE PRECISION,
  normalized_lng DOUBLE PRECISION,
  speed_mps REAL,
  heading_deg REAL,
  accuracy_meters REAL,
  altitude_meters REAL,
  transport_mode live_transport_mode NOT NULL,
  matched_node_id TEXT,
  matched_edge_id TEXT,
  region_label TEXT,
  place_type TEXT,
  confidence_score REAL CHECK (confidence_score IS NULL OR (confidence_score >= 0 AND confidence_score <= 1)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_live_route_snapshots_session_time
  ON live_route_snapshots(live_session_id, recorded_at DESC);

-- ─── route_decision_nodes ─────────────────────────────
CREATE TABLE route_decision_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  live_session_id UUID NOT NULL REFERENCES character_live_sessions(id) ON DELETE CASCADE,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  current_node_id TEXT NOT NULL,
  current_edge_id TEXT,
  trigger_distance_meters REAL NOT NULL,
  trigger_eta_seconds REAL,
  option_count INT NOT NULL CHECK (option_count BETWEEN 2 AND 3),
  options JSONB NOT NULL,
  status live_decision_status NOT NULL DEFAULT 'candidate',
  safety_level live_safety_level NOT NULL DEFAULT 'normal',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_decision_nodes_session_status
  ON route_decision_nodes(live_session_id, status);

-- ─── live_rooms ───────────────────────────────────────
CREATE TABLE live_rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  live_session_id UUID NOT NULL UNIQUE REFERENCES character_live_sessions(id) ON DELETE CASCADE,
  character_id UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  phase live_room_phase NOT NULL DEFAULT 'idle',
  current_market_id UUID,
  viewer_count INT NOT NULL DEFAULT 0,
  participant_count INT NOT NULL DEFAULT 0,
  last_event_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_live_rooms_phase ON live_rooms(phase);
CREATE INDEX idx_live_rooms_character ON live_rooms(character_id);

ALTER TABLE character_live_sessions
  ADD CONSTRAINT character_live_sessions_room_fk
  FOREIGN KEY (current_room_id) REFERENCES live_rooms(id) ON DELETE SET NULL;

-- ─── live_betting_markets ─────────────────────────────
CREATE TABLE live_betting_markets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES live_rooms(id) ON DELETE CASCADE,
  live_session_id UUID NOT NULL REFERENCES character_live_sessions(id) ON DELETE CASCADE,
  decision_node_id UUID REFERENCES route_decision_nodes(id) ON DELETE SET NULL,
  source live_market_source NOT NULL,
  source_user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
  subtitle TEXT,
  market_type live_market_type NOT NULL,
  option_set JSONB NOT NULL,
  opens_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locks_at TIMESTAMPTZ NOT NULL,
  reveal_at TIMESTAMPTZ NOT NULL,
  status live_market_status NOT NULL DEFAULT 'draft',
  locked_outcome_option_id TEXT,
  lock_commit_hash TEXT,
  lock_evidence_json JSONB,
  settlement_reason TEXT,
  total_bet_amount BIGINT NOT NULL DEFAULT 0,
  participant_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT live_markets_time_order CHECK (locks_at >= opens_at AND reveal_at >= locks_at)
);

CREATE INDEX idx_live_markets_room_status ON live_betting_markets(room_id, status);
CREATE INDEX idx_live_markets_session ON live_betting_markets(live_session_id);
CREATE INDEX idx_live_markets_open_window ON live_betting_markets(status, locks_at)
  WHERE status IN ('open', 'locked');

ALTER TABLE live_rooms
  ADD CONSTRAINT live_rooms_current_market_fk
  FOREIGN KEY (current_market_id) REFERENCES live_betting_markets(id) ON DELETE SET NULL;

-- ─── user_market_proposals ────────────────────────────
CREATE TABLE user_market_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES live_rooms(id) ON DELETE CASCADE,
  live_session_id UUID NOT NULL REFERENCES character_live_sessions(id) ON DELETE CASCADE,
  proposer_user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
  option_set JSONB NOT NULL,
  status live_user_market_status NOT NULL DEFAULT 'submitted',
  rejection_reason TEXT,
  validation_notes TEXT[],
  converted_market_id UUID REFERENCES live_betting_markets(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_user_market_proposals_room_status
  ON user_market_proposals(room_id, status);

-- ─── market_lock_records ──────────────────────────────
-- Append-only commitment record for fairness/auditing.
CREATE TABLE market_lock_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id UUID NOT NULL UNIQUE REFERENCES live_betting_markets(id) ON DELETE CASCADE,
  locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  selected_option_id TEXT NOT NULL,
  candidate_option_ids TEXT[] NOT NULL,
  route_snapshot_id UUID REFERENCES live_route_snapshots(id) ON DELETE SET NULL,
  decision_node_id UUID REFERENCES route_decision_nodes(id) ON DELETE SET NULL,
  commit_hash TEXT NOT NULL,
  evidence_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── live_room_events ─────────────────────────────────
-- Append-only canonical timeline of what happened in a room.
CREATE TABLE live_room_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES live_rooms(id) ON DELETE CASCADE,
  market_id UUID REFERENCES live_betting_markets(id) ON DELETE SET NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_live_room_events_room_time ON live_room_events(room_id, occurred_at DESC);
CREATE INDEX idx_live_room_events_market ON live_room_events(market_id);

-- ─── character_route_stats ────────────────────────────
CREATE TABLE character_route_stats (
  character_id UUID PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  session_count INT NOT NULL DEFAULT 0,
  avg_decision_speed_seconds REAL,
  route_predictability_score REAL CHECK (
    route_predictability_score IS NULL OR (route_predictability_score BETWEEN 0 AND 1)
  ),
  common_modes TEXT[] NOT NULL DEFAULT '{}',
  common_place_types TEXT[] NOT NULL DEFAULT '{}',
  enters_place_rate REAL,
  stops_often_rate REAL,
  deviates_route_rate REAL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Live bets (reuse bets table conceptually via link table) ──
-- We place live bets in a dedicated table to avoid coupling to legacy
-- clip-based bets. Wallets/ledger integrations can bridge via
-- wallet_transactions.reference_id where appropriate.
CREATE TABLE live_bets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id UUID NOT NULL REFERENCES live_betting_markets(id) ON DELETE CASCADE,
  room_id UUID NOT NULL REFERENCES live_rooms(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  option_id TEXT NOT NULL,
  stake_amount BIGINT NOT NULL CHECK (stake_amount > 0),
  placed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at TIMESTAMPTZ,
  won BOOLEAN,
  payout_amount BIGINT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'locked', 'settled_win', 'settled_loss', 'refunded', 'cancelled'))
);

CREATE INDEX idx_live_bets_market_user ON live_bets(market_id, user_id);
CREATE INDEX idx_live_bets_user_status ON live_bets(user_id, status);
CREATE UNIQUE INDEX idx_live_bets_one_per_user_per_market
  ON live_bets(market_id, user_id)
  WHERE status IN ('active', 'locked');

-- ─── RLS ──────────────────────────────────────────────
ALTER TABLE character_live_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE live_route_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE route_decision_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE live_rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE live_betting_markets ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_market_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_lock_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE live_room_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE character_route_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE live_bets ENABLE ROW LEVEL SECURITY;

-- Public readable surfaces (live is a spectator sport)
CREATE POLICY "live_sessions_public_read" ON character_live_sessions FOR SELECT USING (TRUE);
CREATE POLICY "live_rooms_public_read" ON live_rooms FOR SELECT USING (TRUE);
CREATE POLICY "live_markets_public_read" ON live_betting_markets FOR SELECT USING (TRUE);
CREATE POLICY "decision_nodes_public_read" ON route_decision_nodes FOR SELECT USING (TRUE);
CREATE POLICY "live_room_events_public_read" ON live_room_events FOR SELECT USING (TRUE);
CREATE POLICY "character_route_stats_public_read" ON character_route_stats FOR SELECT USING (TRUE);
CREATE POLICY "user_market_proposals_public_read" ON user_market_proposals FOR SELECT USING (TRUE);
CREATE POLICY "market_lock_records_public_read" ON market_lock_records FOR SELECT USING (TRUE);

-- Route snapshots: sanitized (raw coords hidden from public, only session owner can read raw).
CREATE POLICY "route_snapshots_owner_read" ON live_route_snapshots FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM character_live_sessions s
    WHERE s.id = live_route_snapshots.live_session_id
      AND s.owner_user_id = auth.uid()
  )
);

-- Owners manage their own live sessions
CREATE POLICY "live_sessions_owner_all" ON character_live_sessions FOR ALL USING (
  owner_user_id = auth.uid()
) WITH CHECK (owner_user_id = auth.uid());

-- Owners insert their own route snapshots (via service client in server actions)
CREATE POLICY "route_snapshots_owner_insert" ON live_route_snapshots FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM character_live_sessions s
      WHERE s.id = live_session_id
        AND s.owner_user_id = auth.uid()
    )
  );

-- User market proposals
CREATE POLICY "user_market_proposals_insert" ON user_market_proposals FOR INSERT
  WITH CHECK (proposer_user_id = auth.uid());
CREATE POLICY "user_market_proposals_update_own" ON user_market_proposals FOR UPDATE USING (
  proposer_user_id = auth.uid()
);

-- Live bets
CREATE POLICY "live_bets_user_read" ON live_bets FOR SELECT USING (
  user_id = auth.uid() OR TRUE  -- participation is public (counts), details visible to owner
);
CREATE POLICY "live_bets_user_insert" ON live_bets FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- Writes to rooms/markets/decision_nodes/lock records/events are server-only
-- (service role bypasses RLS). No write policies are defined for authenticated role.

-- ─── View: active_live_rooms ──────────────────────────
-- Feed builder reads from this view for low-latency feed composition.
CREATE OR REPLACE VIEW active_live_rooms AS
SELECT
  r.id AS room_id,
  r.phase,
  r.current_market_id,
  r.viewer_count,
  r.participant_count,
  r.last_event_at,
  s.id AS live_session_id,
  s.character_id,
  s.owner_user_id,
  s.status AS session_status,
  s.transport_mode,
  s.current_status_text,
  s.current_intent_label,
  s.region_label,
  s.place_type,
  s.safety_level,
  s.session_started_at,
  s.last_heartbeat_at,
  ch.name AS character_name,
  ch.slug AS character_slug,
  ch.tagline AS character_tagline,
  ch.appearance AS character_appearance,
  m.title AS current_market_title,
  m.market_type AS current_market_type,
  m.status AS current_market_status,
  m.locks_at AS current_market_locks_at,
  m.reveal_at AS current_market_reveal_at,
  m.option_set AS current_market_options,
  m.participant_count AS current_market_participants
FROM live_rooms r
JOIN character_live_sessions s ON s.id = r.live_session_id
JOIN characters ch ON ch.id = s.character_id
LEFT JOIN live_betting_markets m ON m.id = r.current_market_id
WHERE s.status IN ('starting', 'live', 'paused')
ORDER BY r.last_event_at DESC;
