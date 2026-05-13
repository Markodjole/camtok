-- ─── 1. Per-market decimal odds ──────────────────────────────────────────────
-- Stored once at market-open time by the server-side tick worker so every
-- viewer reads the same numbers.
-- Shape: { "format": "decimal", "margin": 0.05, "lines": { "<optionId>": 2.86 } }
ALTER TABLE live_betting_markets ADD COLUMN IF NOT EXISTS odds JSONB;

-- ─── 2. Tick advisory lock ────────────────────────────────────────────────────
-- CAS (compare-and-set) column used by the tick worker to ensure only one
-- process mutates a room at a time.  A worker sets this to NOW()+5s; if it
-- is already set to a future time, the worker skips the room and returns
-- {action:"busy"}.  The 5 s TTL self-heals stuck locks on function crashes.
ALTER TABLE live_rooms ADD COLUMN IF NOT EXISTS tick_locked_until TIMESTAMPTZ;

-- ─── 3. Refresh active_live_rooms view to expose odds ────────────────────────
DROP VIEW IF EXISTS active_live_rooms;

CREATE VIEW active_live_rooms AS
SELECT
  r.id                                    AS room_id,
  r.phase,
  r.current_market_id,
  r.viewer_count,
  r.participant_count,
  r.last_event_at,
  s.id                                    AS live_session_id,
  s.character_id,
  s.owner_user_id,
  s.status                                AS session_status,
  s.transport_mode,
  s.current_status_text,
  s.current_intent_label,
  s.region_label,
  s.place_type,
  s.safety_level,
  s.session_started_at,
  s.last_heartbeat_at,
  s.destination_lat,
  s.destination_lng,
  s.destination_label,
  s.destination_place_id,
  ch.name                                 AS character_name,
  ch.slug                                 AS character_slug,
  ch.tagline                              AS character_tagline,
  ch.appearance                           AS character_appearance,
  ch.driving_route_style                  AS character_driving_route_style,
  m.title                                 AS current_market_title,
  m.market_type                           AS current_market_type,
  m.status                                AS current_market_status,
  m.opens_at                              AS current_market_opens_at,
  m.locks_at                              AS current_market_locks_at,
  m.reveal_at                             AS current_market_reveal_at,
  m.option_set                            AS current_market_options,
  m.participant_count                     AS current_market_participants,
  m.turn_point_lat                        AS current_market_turn_point_lat,
  m.turn_point_lng                        AS current_market_turn_point_lng,
  m.city_grid_spec                        AS current_market_city_grid_spec,
  m.odds                                  AS current_market_odds
FROM live_rooms r
JOIN character_live_sessions s  ON s.id = r.live_session_id
JOIN characters ch               ON ch.id = s.character_id
LEFT JOIN live_betting_markets m ON m.id = r.current_market_id
WHERE s.status IN ('starting', 'live', 'paused')
ORDER BY r.last_event_at DESC;
