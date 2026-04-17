-- Visual betting options: tappable hotspots on freeze-frame images
CREATE TABLE IF NOT EXISTS video_frame_options (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clip_node_id  UUID NOT NULL REFERENCES clip_nodes(id) ON DELETE CASCADE,
  frame_timestamp_ms INTEGER NOT NULL DEFAULT 0,
  source        TEXT NOT NULL DEFAULT 'auto_detected' CHECK (source IN ('auto_detected','manual')),
  label         TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  short_label   TEXT CHECK (short_label IS NULL OR char_length(short_label) <= 32),
  object_type   TEXT CHECK (object_type IS NULL OR char_length(object_type) <= 50),
  confidence    REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  is_selected   BOOLEAN NOT NULL DEFAULT FALSE,
  box_x         REAL NOT NULL CHECK (box_x >= 0 AND box_x <= 1),
  box_y         REAL NOT NULL CHECK (box_y >= 0 AND box_y <= 1),
  box_width     REAL NOT NULL CHECK (box_width > 0 AND box_width <= 1),
  box_height    REAL NOT NULL CHECK (box_height > 0 AND box_height <= 1),
  z_index       INTEGER,
  prediction_market_id UUID REFERENCES prediction_markets(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_frame_options_clip ON video_frame_options(clip_node_id);
CREATE INDEX IF NOT EXISTS idx_frame_options_clip_selected ON video_frame_options(clip_node_id) WHERE is_selected = TRUE;

ALTER TABLE video_frame_options ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read frame options" ON video_frame_options;
CREATE POLICY "Anyone can read frame options"
  ON video_frame_options FOR SELECT
  USING (TRUE);

DROP POLICY IF EXISTS "Clip creator can manage frame options" ON video_frame_options;
CREATE POLICY "Clip creator can manage frame options"
  ON video_frame_options FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM clip_nodes cn
      WHERE cn.id = video_frame_options.clip_node_id
        AND cn.creator_user_id = auth.uid()
    )
  );

-- Update feed_clips view to flag clips that have visual frame options
DROP VIEW IF EXISTS feed_clips;

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
  NULLIF(BTRIM(cn.llm_generation_json->>'capture_location_text'), '') AS capture_location_text,
  cn.genre,
  cn.tone,
  cn.pause_start_ms,
  cn.duration_ms,
  cn.betting_deadline,
  cn.view_count,
  cn.bet_count,
  cn.published_at,
  cn.winning_outcome_text,
  cn.resolution_reason_text,
  cn.resolved_at,
  cn.transcript,
  cn.character_id,
  COALESCE(part2.video_storage_path, cn.part2_video_storage_path) AS part2_video_storage_path,
  s.title AS story_title,
  p.username AS creator_username,
  p.display_name AS creator_display_name,
  p.avatar_path AS creator_avatar_path,
  ch.name AS character_name,
  ch.slug AS character_slug,
  ch.tagline AS character_tagline,
  ch.appearance AS character_appearance,
  ch.betting_signals AS character_betting_signals,
  (EXISTS (
    SELECT 1 FROM video_frame_options vfo
    WHERE vfo.clip_node_id = cn.id AND vfo.is_selected = TRUE
  )) AS has_frame_options
FROM clip_nodes cn
JOIN stories s ON s.id = cn.story_id
JOIN profiles p ON p.id = cn.creator_user_id
LEFT JOIN settlement_results sr ON sr.clip_node_id = cn.id
LEFT JOIN clip_nodes part2 ON part2.id = sr.continuation_clip_node_id
LEFT JOIN characters ch ON ch.id = cn.character_id
WHERE cn.status IN ('betting_open', 'continuation_ready', 'settled', 'betting_locked', 'continuation_generating')
  AND cn.published_at IS NOT NULL
ORDER BY cn.published_at DESC;
