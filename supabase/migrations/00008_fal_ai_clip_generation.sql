-- fal.ai clip generation: blueprints + generation jobs + clip metadata

CREATE TABLE IF NOT EXISTS clip_blueprints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clip_generation_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  blueprint_id UUID REFERENCES clip_blueprints(id),
  clip_node_id UUID REFERENCES clip_nodes(id),
  status TEXT NOT NULL DEFAULT 'queued',
  provider TEXT NOT NULL DEFAULT 'fal',
  image_model_key TEXT,
  video_model_key TEXT,
  first_frame_request_id TEXT,
  end_frame_request_id TEXT,
  video_request_id TEXT,
  error_message TEXT,
  llm_generation_json JSONB,
  first_frame_storage_path TEXT,
  end_frame_storage_path TEXT,
  video_storage_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE clip_nodes
  ADD COLUMN IF NOT EXISTS blueprint_id UUID REFERENCES clip_blueprints(id),
  ADD COLUMN IF NOT EXISTS llm_generation_json JSONB,
  ADD COLUMN IF NOT EXISTS first_frame_storage_path TEXT,
  ADD COLUMN IF NOT EXISTS end_frame_storage_path TEXT;

-- Seed a minimal set of reliable blueprints (idempotent).
INSERT INTO clip_blueprints (slug, label, category, description, config_json)
VALUES
  (
    'object_approaching_target',
    'Object approaching target',
    'object_approaching_target',
    'An object moves toward a target but cuts before contact.',
    jsonb_build_object(
      'suggested_outcomes', jsonb_build_array(
        'Object reaches target',
        'Object stops before target',
        'Object veers away'
      )
    )
  ),
  (
    'left_right_choice',
    'Left / right choice',
    'left_right_choice',
    'A character approaches two choices; clip cuts before decision.',
    jsonb_build_object(
      'suggested_outcomes', jsonb_build_array(
        'Chooses left',
        'Chooses right',
        'Stops before choosing'
      )
    )
  ),
  (
    'reach_without_resolution',
    'Reach without touching',
    'reach_without_resolution',
    'A character reaches toward something but cuts before contact.',
    jsonb_build_object(
      'suggested_outcomes', jsonb_build_array(
        'Touches the object',
        'Misses the object',
        'Stops short'
      )
    )
  ),
  (
    'balance_before_fall',
    'Balance before fall',
    'balance_before_fall',
    'An object wobbles near an edge; clip cuts before it falls.',
    jsonb_build_object(
      'suggested_outcomes', jsonb_build_array(
        'Falls off',
        'Stabilizes',
        'Stays wobbling'
      )
    )
  ),
  (
    'suspense_reveal_setup',
    'Suspense reveal setup',
    'suspense_reveal_setup',
    'A container/door is about to open; cuts before reveal.',
    jsonb_build_object(
      'suggested_outcomes', jsonb_build_array(
        'Opens',
        'Does not open',
        'Opens slightly then stops'
      )
    )
  )
ON CONFLICT (slug) DO UPDATE
SET
  label = EXCLUDED.label,
  category = EXCLUDED.category,
  description = EXCLUDED.description,
  config_json = EXCLUDED.config_json,
  active = true;

