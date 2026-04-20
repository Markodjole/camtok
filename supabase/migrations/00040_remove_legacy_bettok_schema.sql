-- =========================================================
-- Remove legacy BetTok AI clip/story schema (destructive)
-- =========================================================
-- This migration drops archive-era entities related to:
-- - story/clip generation
-- - prediction markets on clip pauses
-- - continuation jobs and settlement artifacts
-- - image/video generation and analysis helper tables
--
-- Keep: profiles/wallets/live route betting/Camtok character model.

-- Views
DROP VIEW IF EXISTS feed_clips;

-- Legacy comment/social around prediction markets
DROP TABLE IF EXISTS prediction_comments CASCADE;

-- Legacy AI image/video pipeline artifacts
DROP TABLE IF EXISTS video_frame_options CASCADE;
DROP TABLE IF EXISTS video_analyses CASCADE;
DROP TABLE IF EXISTS image_patterns CASCADE;
DROP TABLE IF EXISTS clip_generation_jobs CASCADE;
DROP TABLE IF EXISTS clip_blueprints CASCADE;

-- Legacy clip/story betting engine
DROP TABLE IF EXISTS settlement_side_results CASCADE;
DROP TABLE IF EXISTS settlement_results CASCADE;
DROP TABLE IF EXISTS continuation_jobs CASCADE;
DROP TABLE IF EXISTS odds_snapshots CASCADE;
DROP TABLE IF EXISTS bets CASCADE;
DROP TABLE IF EXISTS market_sides CASCADE;
DROP TABLE IF EXISTS prediction_markets CASCADE;
DROP TABLE IF EXISTS clip_context_snapshots CASCADE;
DROP TABLE IF EXISTS character_trait_events CASCADE;
DROP TABLE IF EXISTS clip_nodes CASCADE;
DROP TABLE IF EXISTS stories CASCADE;

-- Legacy prompt/logging tables for clip generation flow
DROP TABLE IF EXISTS llm_prompt_versions CASCADE;
DROP TABLE IF EXISTS llm_runs CASCADE;

-- Remove enums only used by dropped BetTok objects
DROP TYPE IF EXISTS clip_source_type CASCADE;
DROP TYPE IF EXISTS clip_node_status CASCADE;
DROP TYPE IF EXISTS bet_status CASCADE;
DROP TYPE IF EXISTS prediction_status CASCADE;
DROP TYPE IF EXISTS continuation_job_status CASCADE;
DROP TYPE IF EXISTS market_side_key CASCADE;
DROP TYPE IF EXISTS llm_purpose CASCADE;
