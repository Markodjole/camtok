-- Add driver-specific stat columns to character_public_game_stats.
-- missed_turns_total: incremented when settlement reveals driver went straight on a directional turn market.
-- sessions_total: incremented on each session end.
-- total_distance_km: accumulated GPS distance.

ALTER TABLE character_public_game_stats
  ADD COLUMN IF NOT EXISTS missed_turns_total   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sessions_total       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_distance_km    NUMERIC(10,3) NOT NULL DEFAULT 0;

COMMENT ON COLUMN character_public_game_stats.missed_turns_total
  IS 'Number of directional turn markets where the driver went straight instead of turning.';
COMMENT ON COLUMN character_public_game_stats.sessions_total
  IS 'Total live sessions completed by this driver character.';
COMMENT ON COLUMN character_public_game_stats.total_distance_km
  IS 'Cumulative GPS distance driven across all sessions.';
