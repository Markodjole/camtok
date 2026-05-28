-- Independent "step" market slot on live_rooms.
--
-- next_step markets (time-to-pin / time-to-camera) now run in their own
-- slot (current_step_market_id) rather than the main slot (current_market_id).
-- This lets a zone bet and a pin bet run simultaneously without either one
-- blocking the other.  The main phase / current_market_id remain unchanged
-- for zone_exit_time, next_turn, city_grid, and straight_streak markets.

ALTER TABLE live_rooms
  ADD COLUMN IF NOT EXISTS current_step_market_id UUID
    REFERENCES live_betting_markets(id) ON DELETE SET NULL;

-- Expose the step market alongside the main market in the live rooms view.
DROP VIEW IF EXISTS active_live_rooms;

CREATE VIEW active_live_rooms AS
SELECT
  r.id                                    AS room_id,
  r.phase,
  r.current_market_id,
  r.current_step_market_id,
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
  -- Main market slot (zone / turn / streak / city_grid)
  m.title                                 AS current_market_title,
  m.market_type                           AS current_market_type,
  m.status                                AS current_market_status,
  m.opens_at                              AS current_market_opens_at,
  m.locks_at                              AS current_market_locks_at,
  m.reveal_at                             AS current_market_reveal_at,
  m.option_set                            AS current_market_options,
  m.subtitle                              AS current_market_subtitle,
  m.participant_count                     AS current_market_participants,
  m.turn_point_lat                        AS current_market_turn_point_lat,
  m.turn_point_lng                        AS current_market_turn_point_lng,
  m.city_grid_spec                        AS current_market_city_grid_spec,
  m.odds                                  AS current_market_odds,
  -- Step market slot (next_step: pin / camera bets)
  sm.title                                AS current_step_market_title,
  sm.market_type                          AS current_step_market_type,
  sm.status                               AS current_step_market_status,
  sm.opens_at                             AS current_step_market_opens_at,
  sm.locks_at                             AS current_step_market_locks_at,
  sm.reveal_at                            AS current_step_market_reveal_at,
  sm.option_set                           AS current_step_market_options,
  sm.subtitle                             AS current_step_market_subtitle,
  sm.participant_count                    AS current_step_market_participants,
  sm.turn_point_lat                       AS current_step_market_turn_point_lat,
  sm.turn_point_lng                       AS current_step_market_turn_point_lng,
  sm.odds                                 AS current_step_market_odds
FROM live_rooms r
JOIN character_live_sessions s  ON s.id = r.live_session_id
JOIN characters ch               ON ch.id = s.character_id
LEFT JOIN live_betting_markets m  ON m.id = r.current_market_id
LEFT JOIN live_betting_markets sm ON sm.id = r.current_step_market_id
WHERE s.status IN ('starting', 'live', 'paused')
ORDER BY r.last_event_at DESC;
