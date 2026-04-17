-- =========================================================
-- BetTok / StoryBet — Initial Database Schema
-- =========================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── Enums ──────────────────────────────────────────────

CREATE TYPE clip_source_type AS ENUM (
  'upload', 'text_to_video', 'image_to_video', 'continuation'
);

CREATE TYPE clip_node_status AS ENUM (
  'draft', 'processing', 'ready_for_betting', 'betting_open',
  'betting_locked', 'continuation_generating', 'continuation_ready',
  'settled', 'archived', 'failed'
);

CREATE TYPE bet_status AS ENUM (
  'pending_hold', 'active', 'locked', 'settled_win',
  'settled_loss', 'cancelled', 'refunded'
);

CREATE TYPE prediction_status AS ENUM (
  'raw_submitted', 'normalized', 'open', 'locked',
  'settled', 'rejected_moderation', 'rejected_normalization'
);

CREATE TYPE continuation_job_status AS ENUM (
  'queued', 'running', 'generated_text', 'generated_media',
  'validated', 'failed', 'published'
);

CREATE TYPE wallet_tx_type AS ENUM (
  'deposit_demo', 'withdrawal_demo', 'bet_hold', 'bet_release',
  'bet_win', 'bet_loss', 'admin_adjustment', 'referral_bonus',
  'creator_reward'
);

CREATE TYPE hold_status AS ENUM ('active', 'released', 'converted');

CREATE TYPE market_side_key AS ENUM ('yes', 'no');

CREATE TYPE notification_type AS ENUM (
  'bet_locked', 'prediction_accepted', 'continuation_live',
  'bet_settled', 'bet_won', 'bet_lost', 'partially_correct',
  'clip_first_bets', 'moderation_action'
);

CREATE TYPE user_role AS ENUM ('viewer', 'creator', 'moderator', 'admin');

CREATE TYPE report_status AS ENUM ('pending', 'reviewed', 'dismissed', 'actioned');
CREATE TYPE report_target_type AS ENUM ('clip', 'prediction', 'profile', 'comment');

CREATE TYPE llm_purpose AS ENUM (
  'normalization', 'odds', 'continuation', 'settlement', 'moderation'
);

-- ─── Profiles ───────────────────────────────────────────

CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username TEXT UNIQUE NOT NULL CHECK (char_length(username) >= 3 AND char_length(username) <= 30),
  display_name TEXT NOT NULL CHECK (char_length(display_name) >= 1 AND char_length(display_name) <= 60),
  avatar_path TEXT,
  bio TEXT CHECK (char_length(bio) <= 300),
  country_code CHAR(2),
  wallet_visibility TEXT NOT NULL DEFAULT 'private' CHECK (wallet_visibility IN ('public', 'private')),
  preferred_language TEXT NOT NULL DEFAULT 'en',
  notification_preferences JSONB NOT NULL DEFAULT '{"in_app": true, "push": false}',
  role user_role NOT NULL DEFAULT 'viewer',
  total_bets INTEGER NOT NULL DEFAULT 0,
  total_wins INTEGER NOT NULL DEFAULT 0,
  total_predictions INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_profiles_username ON profiles(username);

-- ─── Wallets ────────────────────────────────────────────

CREATE TABLE wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID UNIQUE NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  balance NUMERIC(12, 2) NOT NULL DEFAULT 0,
  total_deposited NUMERIC(12, 2) NOT NULL DEFAULT 0,
  total_withdrawn NUMERIC(12, 2) NOT NULL DEFAULT 0,
  total_won NUMERIC(12, 2) NOT NULL DEFAULT 0,
  total_lost NUMERIC(12, 2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE wallet_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID NOT NULL REFERENCES wallets(id),
  type wallet_tx_type NOT NULL,
  amount NUMERIC(12, 2) NOT NULL,
  balance_after NUMERIC(12, 2) NOT NULL,
  reference_type TEXT,
  reference_id UUID,
  description TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_wallet_tx_wallet ON wallet_transactions(wallet_id);
CREATE INDEX idx_wallet_tx_created ON wallet_transactions(created_at DESC);
CREATE INDEX idx_wallet_tx_ref ON wallet_transactions(reference_type, reference_id);

CREATE TABLE wallet_holds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID NOT NULL REFERENCES wallets(id),
  bet_id UUID NOT NULL,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  status hold_status NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ
);

CREATE INDEX idx_wallet_holds_wallet ON wallet_holds(wallet_id);
CREATE INDEX idx_wallet_holds_status ON wallet_holds(status) WHERE status = 'active';

-- ─── Stories & Clips ────────────────────────────────────

CREATE TABLE stories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL CHECK (char_length(title) >= 1 AND char_length(title) <= 200),
  description TEXT CHECK (char_length(description) <= 1000),
  genre TEXT,
  tone TEXT,
  realism_level TEXT,
  creator_user_id UUID NOT NULL REFERENCES auth.users(id),
  root_clip_node_id UUID,
  max_depth INTEGER NOT NULL DEFAULT 0,
  total_bets INTEGER NOT NULL DEFAULT 0,
  total_clips INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_stories_creator ON stories(creator_user_id);

CREATE TABLE clip_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id UUID NOT NULL REFERENCES stories(id),
  parent_clip_node_id UUID REFERENCES clip_nodes(id),
  depth INTEGER NOT NULL DEFAULT 0,
  creator_user_id UUID NOT NULL REFERENCES auth.users(id),
  source_type clip_source_type NOT NULL,
  status clip_node_status NOT NULL DEFAULT 'draft',
  video_storage_path TEXT,
  poster_storage_path TEXT,
  transcript TEXT,
  scene_summary TEXT,
  genre TEXT,
  tone TEXT,
  realism_level TEXT,
  pause_start_ms INTEGER,
  pause_end_ms INTEGER,
  duration_ms INTEGER,
  betting_deadline TIMESTAMPTZ,
  view_count INTEGER NOT NULL DEFAULT 0,
  bet_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);

CREATE INDEX idx_clip_nodes_story ON clip_nodes(story_id);
CREATE INDEX idx_clip_nodes_parent ON clip_nodes(parent_clip_node_id);
CREATE INDEX idx_clip_nodes_status ON clip_nodes(status);
CREATE INDEX idx_clip_nodes_feed ON clip_nodes(published_at DESC) WHERE status IN ('betting_open', 'continuation_ready', 'settled');

ALTER TABLE stories ADD CONSTRAINT fk_root_clip
  FOREIGN KEY (root_clip_node_id) REFERENCES clip_nodes(id);

CREATE TABLE clip_context_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clip_node_id UUID NOT NULL REFERENCES clip_nodes(id),
  context_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Prediction Markets ─────────────────────────────────

CREATE TABLE prediction_markets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clip_node_id UUID NOT NULL REFERENCES clip_nodes(id),
  raw_creator_input TEXT NOT NULL,
  canonical_text TEXT NOT NULL,
  market_key TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  normalization_confidence NUMERIC(4, 3) NOT NULL DEFAULT 0,
  normalization_explanation TEXT,
  created_by_user_id UUID NOT NULL REFERENCES auth.users(id),
  status prediction_status NOT NULL DEFAULT 'raw_submitted',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_pm_clip_key ON prediction_markets(clip_node_id, market_key);
CREATE INDEX idx_pm_clip ON prediction_markets(clip_node_id);
CREATE INDEX idx_pm_status ON prediction_markets(status);

CREATE TABLE market_sides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prediction_market_id UUID NOT NULL REFERENCES prediction_markets(id),
  side_key market_side_key NOT NULL,
  current_odds_decimal NUMERIC(8, 2) NOT NULL DEFAULT 2.00,
  probability NUMERIC(5, 4) NOT NULL DEFAULT 0.5000,
  pool_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  bet_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (prediction_market_id, side_key)
);

CREATE INDEX idx_ms_market ON market_sides(prediction_market_id);

-- ─── Bets ───────────────────────────────────────────────

CREATE TABLE bets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  clip_node_id UUID NOT NULL REFERENCES clip_nodes(id),
  prediction_market_id UUID NOT NULL REFERENCES prediction_markets(id),
  market_side_id UUID NOT NULL REFERENCES market_sides(id),
  side_key market_side_key NOT NULL,
  stake_amount NUMERIC(12, 2) NOT NULL CHECK (stake_amount > 0),
  odds_at_bet NUMERIC(8, 2) NOT NULL,
  available_balance_snapshot NUMERIC(12, 2) NOT NULL,
  status bet_status NOT NULL DEFAULT 'pending_hold',
  payout_amount NUMERIC(12, 2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ
);

CREATE INDEX idx_bets_user ON bets(user_id);
CREATE INDEX idx_bets_clip ON bets(clip_node_id);
CREATE INDEX idx_bets_market ON bets(prediction_market_id);
CREATE INDEX idx_bets_status ON bets(status);

-- ─── Odds Snapshots ─────────────────────────────────────

CREATE TABLE odds_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prediction_market_id UUID NOT NULL REFERENCES prediction_markets(id),
  clip_node_id UUID NOT NULL REFERENCES clip_nodes(id),
  probability_yes NUMERIC(5, 4) NOT NULL,
  probability_no NUMERIC(5, 4) NOT NULL,
  decimal_odds_yes NUMERIC(8, 2) NOT NULL,
  decimal_odds_no NUMERIC(8, 2) NOT NULL,
  reasoning_short TEXT NOT NULL,
  reasoning_detailed TEXT,
  plausibility_score NUMERIC(5, 4),
  cinematic_score NUMERIC(5, 4),
  surprise_score NUMERIC(5, 4),
  retention_score NUMERIC(5, 4),
  rejected_for_story_break BOOLEAN NOT NULL DEFAULT false,
  llm_run_id UUID,
  prompt_version TEXT NOT NULL,
  algorithm_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_odds_market ON odds_snapshots(prediction_market_id);

-- ─── Continuation Jobs ──────────────────────────────────

CREATE TABLE continuation_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clip_node_id UUID NOT NULL REFERENCES clip_nodes(id),
  status continuation_job_status NOT NULL DEFAULT 'queued',
  continuation_summary TEXT,
  accepted_predictions TEXT[],
  rejected_predictions TEXT[],
  partially_matched TEXT[],
  media_prompt TEXT,
  scene_explanation TEXT,
  result_clip_node_id UUID REFERENCES clip_nodes(id),
  llm_run_id UUID,
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX idx_cont_jobs_clip ON continuation_jobs(clip_node_id);
CREATE INDEX idx_cont_jobs_status ON continuation_jobs(status);

-- ─── Settlement ─────────────────────────────────────────

CREATE TABLE settlement_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clip_node_id UUID NOT NULL REFERENCES clip_nodes(id),
  continuation_clip_node_id UUID NOT NULL REFERENCES clip_nodes(id),
  algorithm_version TEXT NOT NULL,
  llm_run_id UUID,
  summary TEXT NOT NULL,
  settled_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_settlement_clip ON settlement_results(clip_node_id);

CREATE TABLE settlement_side_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_result_id UUID NOT NULL REFERENCES settlement_results(id),
  prediction_market_id UUID NOT NULL REFERENCES prediction_markets(id),
  yes_correctness NUMERIC(5, 4) NOT NULL,
  no_correctness NUMERIC(5, 4) NOT NULL,
  winner_side market_side_key,
  strength NUMERIC(5, 4) NOT NULL,
  transfer_amount NUMERIC(12, 2) NOT NULL,
  explanation_short TEXT NOT NULL,
  explanation_long TEXT,
  confidence NUMERIC(5, 4) NOT NULL,
  evidence_bullets JSONB
);

CREATE INDEX idx_ssr_settlement ON settlement_side_results(settlement_result_id);
CREATE INDEX idx_ssr_market ON settlement_side_results(prediction_market_id);

-- ─── LLM Runs ──────────────────────────────────────────

CREATE TABLE llm_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  purpose llm_purpose NOT NULL,
  prompt_version TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  latency_ms INTEGER,
  input_snapshot JSONB NOT NULL,
  output_snapshot JSONB NOT NULL,
  validated BOOLEAN NOT NULL DEFAULT false,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_llm_runs_purpose ON llm_runs(purpose);
CREATE INDEX idx_llm_runs_created ON llm_runs(created_at DESC);

CREATE TABLE llm_prompt_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (name, version)
);

-- ─── Notifications ──────────────────────────────────────

CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  type notification_type NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  link TEXT,
  reference_type TEXT,
  reference_id UUID,
  read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifications_user ON notifications(user_id);
CREATE INDEX idx_notifications_unread ON notifications(user_id, read) WHERE read = false;
CREATE INDEX idx_notifications_created ON notifications(created_at DESC);

-- ─── Reports ────────────────────────────────────────────

CREATE TABLE reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_user_id UUID NOT NULL REFERENCES auth.users(id),
  target_type report_target_type NOT NULL,
  target_id UUID NOT NULL,
  reason TEXT NOT NULL,
  status report_status NOT NULL DEFAULT 'pending',
  moderator_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX idx_reports_status ON reports(status);

-- ─── Feed View ──────────────────────────────────────────

CREATE OR REPLACE VIEW feed_clips AS
SELECT
  cn.id,
  cn.story_id,
  cn.parent_clip_node_id,
  cn.depth,
  cn.creator_user_id,
  cn.source_type,
  cn.status,
  cn.video_storage_path,
  cn.poster_storage_path,
  cn.scene_summary,
  cn.genre,
  cn.tone,
  cn.pause_start_ms,
  cn.duration_ms,
  cn.betting_deadline,
  cn.view_count,
  cn.bet_count,
  cn.published_at,
  s.title AS story_title,
  p.username AS creator_username,
  p.display_name AS creator_display_name,
  p.avatar_path AS creator_avatar_path
FROM clip_nodes cn
JOIN stories s ON s.id = cn.story_id
JOIN profiles p ON p.id = cn.creator_user_id
WHERE cn.status IN ('betting_open', 'continuation_ready', 'settled')
  AND cn.published_at IS NOT NULL
ORDER BY cn.published_at DESC;

-- ─── RLS Policies ───────────────────────────────────────

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE stories ENABLE ROW LEVEL SECURITY;
ALTER TABLE clip_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE prediction_markets ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_sides ENABLE ROW LEVEL SECURITY;
ALTER TABLE bets ENABLE ROW LEVEL SECURITY;
ALTER TABLE odds_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;

-- Profiles: public read, own write
CREATE POLICY profiles_read ON profiles FOR SELECT USING (true);
CREATE POLICY profiles_update ON profiles FOR UPDATE USING (auth.uid() = id);

-- Wallets: own read only
CREATE POLICY wallets_read ON wallets FOR SELECT USING (auth.uid() = user_id);

-- Wallet transactions: own read only
CREATE POLICY wallet_tx_read ON wallet_transactions FOR SELECT
  USING (wallet_id IN (SELECT id FROM wallets WHERE user_id = auth.uid()));

-- Stories: public read, creator write
CREATE POLICY stories_read ON stories FOR SELECT USING (true);
CREATE POLICY stories_insert ON stories FOR INSERT WITH CHECK (auth.uid() = creator_user_id);
CREATE POLICY stories_update ON stories FOR UPDATE USING (auth.uid() = creator_user_id);

-- Clip nodes: public read for published, creator write
CREATE POLICY clip_nodes_read ON clip_nodes FOR SELECT USING (true);
CREATE POLICY clip_nodes_insert ON clip_nodes FOR INSERT WITH CHECK (auth.uid() = creator_user_id);

-- Prediction markets: public read, authenticated insert
CREATE POLICY pm_read ON prediction_markets FOR SELECT USING (true);
CREATE POLICY pm_insert ON prediction_markets FOR INSERT WITH CHECK (auth.uid() = created_by_user_id);

-- Market sides: public read
CREATE POLICY ms_read ON market_sides FOR SELECT USING (true);

-- Bets: own read, own insert
CREATE POLICY bets_read ON bets FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY bets_insert ON bets FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Odds: public read
CREATE POLICY odds_read ON odds_snapshots FOR SELECT USING (true);

-- Notifications: own only
CREATE POLICY notif_read ON notifications FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY notif_update ON notifications FOR UPDATE USING (auth.uid() = user_id);

-- Reports: own insert
CREATE POLICY reports_insert ON reports FOR INSERT WITH CHECK (auth.uid() = reporter_user_id);

-- ─── Functions ──────────────────────────────────────────

-- Auto-create profile and wallet on signup
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO profiles (id, username, display_name)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'username', 'user_' || substr(NEW.id::text, 1, 8)),
    COALESCE(NEW.raw_user_meta_data->>'display_name', 'New User')
  );

  INSERT INTO wallets (user_id, balance)
  VALUES (NEW.id, 1000.00);

  INSERT INTO wallet_transactions (wallet_id, type, amount, balance_after, description)
  SELECT w.id, 'deposit_demo', 1000.00, 1000.00, 'Welcome bonus'
  FROM wallets w WHERE w.user_id = NEW.id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();
