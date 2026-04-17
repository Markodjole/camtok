-- ─── Video analysis: structured extraction from clip videos ─────────────────

CREATE TABLE IF NOT EXISTS video_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clip_node_id UUID NOT NULL REFERENCES clip_nodes(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','sampling_frames','extracting_vision','extracting_temporal','deriving_features','stored','failed')),
  version INT NOT NULL DEFAULT 1,

  -- Three truth levels stored as JSONB
  observed JSONB,              -- directly visible facts
  inferred JSONB,              -- soft signals from context
  derived JSONB,               -- computed continuation features

  warnings JSONB DEFAULT '[]'::jsonb,
  score JSONB,
  frame_count INT,
  analysis_model TEXT,

  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,

  UNIQUE (clip_node_id, version)
);

CREATE INDEX idx_video_analyses_clip ON video_analyses(clip_node_id);
CREATE INDEX idx_video_analyses_status ON video_analyses(status) WHERE status NOT IN ('stored', 'failed');
