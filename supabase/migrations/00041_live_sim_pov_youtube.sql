-- Sim / dashcam POV: store YouTube video id + start offset so viewers can embed
-- the same feed (WebRTC may carry synthetic video when source is HLS-only).

ALTER TABLE character_live_sessions
  ADD COLUMN IF NOT EXISTS sim_pov_youtube_id TEXT,
  ADD COLUMN IF NOT EXISTS sim_pov_youtube_start_sec INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN character_live_sessions.sim_pov_youtube_id IS 'YouTube video id (11 chars) for viewer POV embed when sim dashcam uses YouTube';
COMMENT ON COLUMN character_live_sessions.sim_pov_youtube_start_sec IS 'YouTube embed start offset in seconds';

-- Must DROP VIEW first: PostgreSQL CREATE OR REPLACE VIEW cannot insert new
-- columns before existing ones (ordinal / rename conflict).
DROP VIEW IF EXISTS active_live_rooms;

CREATE VIEW active_live_rooms AS
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
  m.participant_count AS current_market_participants,
  s.sim_pov_youtube_id,
  s.sim_pov_youtube_start_sec
FROM live_rooms r
JOIN character_live_sessions s ON s.id = r.live_session_id
JOIN characters ch ON ch.id = s.character_id
LEFT JOIN live_betting_markets m ON m.id = r.current_market_id
WHERE s.status IN ('starting', 'live', 'paused')
ORDER BY r.last_event_at DESC;
