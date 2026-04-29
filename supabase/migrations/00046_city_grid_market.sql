-- City grid live markets: deterministic 500 m WGS84 cells (A1, B2, …).
ALTER TYPE live_market_type ADD VALUE IF NOT EXISTS 'city_grid';

ALTER TABLE live_betting_markets
  ADD COLUMN IF NOT EXISTS city_grid_spec JSONB;

COMMENT ON COLUMN live_betting_markets.city_grid_spec IS
  'Compact grid definition: swLat, swLng, dLat, dLng, nCols, nRows, cellMeters, cityLabel. Settlement uses cellIdForPosition.';

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
  m.turn_point_lat AS current_market_turn_point_lat,
  m.turn_point_lng AS current_market_turn_point_lng,
  m.city_grid_spec AS current_market_city_grid_spec
FROM live_rooms r
JOIN character_live_sessions s ON s.id = r.live_session_id
JOIN characters ch ON ch.id = s.character_id
LEFT JOIN live_betting_markets m ON m.id = r.current_market_id
WHERE s.status IN ('starting', 'live', 'paused')
ORDER BY r.last_event_at DESC;
