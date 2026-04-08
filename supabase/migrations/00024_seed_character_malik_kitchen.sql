-- Seed a new predefined character from provided kitchen image set.
-- Includes full profile + betting_signals + 5 reference image rows.

INSERT INTO characters (
  slug,
  name,
  tagline,
  appearance,
  personality,
  preferences,
  backstory,
  voice,
  betting_signals,
  sort_order,
  active
)
VALUES (
  'malik',
  'Malik',
  'Calm precision cook who values quality, rhythm, and control',
  jsonb_build_object(
    'age_range', '27-33',
    'gender_presentation', 'male',
    'build', 'lean athletic',
    'height', 'tall (183cm)',
    'hair', jsonb_build_object(
      'color', 'black',
      'style', 'short fade with textured top',
      'facial_hair', 'trimmed mustache and goatee'
    ),
    'skin_tone', 'deep brown',
    'distinguishing_features', jsonb_build_array(
      'thin metal-frame glasses',
      'clean minimalist black t-shirt style',
      'focused downward gaze while cooking',
      'precise hand control around bowls and pans'
    ),
    'default_outfit', jsonb_build_object(
      'top', 'plain black crew-neck t-shirt',
      'bottom', 'dark neutral pants (kitchen casual)',
      'shoes', 'minimal dark sneakers',
      'accessories', jsonb_build_array(
        'thin metal-frame glasses'
      )
    )
  ),
  jsonb_build_object(
    'big_five', jsonb_build_object(
      'openness', 0.72,
      'conscientiousness', 0.88,
      'extraversion', 0.42,
      'agreeableness', 0.71,
      'neuroticism', 0.26
    ),
    'temperament', 'calm, deliberate, quality-focused, quietly confident',
    'decision_style', 'methodical — sequences tasks step-by-step, prioritizes consistency and clean execution',
    'risk_appetite', 'moderate-low — experiments only when core process is stable',
    'social_style', 'polite and reserved, explains clearly when asked, avoids loud attention',
    'under_pressure', 'slows down and tightens form rather than rushing',
    'attention_span', 'long for craft tasks; tracks multiple micro-steps without losing flow',
    'physical_behavior', jsonb_build_object(
      'energy_level', 'medium — steady kitchen tempo, never frantic',
      'movement_style', 'smooth, controlled, ergonomic, minimal wasted motion',
      'posture', 'upright with slight forward lean over work surface during precision steps',
      'typical_gestures', jsonb_build_array(
        'checks mixture texture before committing next step',
        're-centers tools neatly after each action',
        'brief pause before pouring or flipping',
        'small wrist-led motions instead of large arm swings',
        'keeps workspace organized while cooking'
      ),
      'walking_pace', 'measured and purposeful, short efficient routes in kitchen',
      'emotional_expressiveness', 'subtle — concentration face, small nods when result looks right',
      'comfort_zone', jsonb_build_array(
        'home kitchen counters',
        'stove + prep workflow',
        'breakfast prep environments',
        'clean, well-lit cooking spaces'
      ),
      'behavioral_red_flags', jsonb_build_array(
        'chaotic rushing between stations',
        'large careless gestures near hot surfaces',
        'abandoning mise-en-place discipline',
        'showy impulsive moves for attention',
        'messy workspace buildup while still cooking'
      )
    )
  ),
  jsonb_build_object(
    'food', jsonb_build_object(
      'likes', jsonb_build_array(
        'pancakes',
        'eggs',
        'fresh berries',
        'lightly sweet breakfasts',
        'homemade batters',
        'balanced high-protein meals'
      ),
      'dislikes', jsonb_build_array(
        'overly processed instant meals',
        'sloppy presentation',
        'burnt or overcooked textures'
      )
    ),
    'activities', jsonb_build_object(
      'likes', jsonb_build_array(
        'home cooking',
        'recipe iteration',
        'meal prep planning',
        'kitchen organization',
        'quiet morning routines'
      ),
      'dislikes', jsonb_build_array(
        'noisy crowded kitchens',
        'disorganized prep',
        'rushed shortcuts that reduce quality'
      )
    ),
    'brands', jsonb_build_object(
      'likes', jsonb_build_array(
        'IKEA kitchenware',
        'OXO',
        'Lodge',
        'Muji',
        'quality store brands when ingredients are clean'
      ),
      'dislikes', jsonb_build_array(
        'gimmicky kitchen gadgets',
        'overpriced premium branding with no quality gain'
      )
    ),
    'shopping', 'checks quality, consistency, and value before choosing — same habit in any setting',
    'general_tendencies', jsonb_build_array(
      'chooses reliable options over trendy ones',
      'keeps his space and process tidy while doing something',
      'verifies the important detail before moving on',
      'prefers repeatable methods over flashy improvisation',
      'finishes one step cleanly before starting the next'
    )
  ),
  'Malik learned cooking through disciplined breakfast routines and iterative practice in small home kitchens. He treats cooking like a craft system: mise-en-place, controlled heat, and consistent execution. He is not theatrical; he optimizes for quality and repeatability.',
  jsonb_build_object(
    'tone', 'calm, precise, instructional when needed',
    'vocabulary', 'practical kitchen language, concise',
    'catchphrases', jsonb_build_array(
      'keep it clean',
      'control the heat',
      'texture first'
    )
  ),
  jsonb_build_object(
    'quick_read', jsonb_build_array(
      'Chooses consistency over speed (82%)',
      'Keeps his process organized (86%)',
      'Avoids flashy risky moves (78%)'
    ),
    'choice_patterns', jsonb_build_object(
      'reliable_trusted_option', 0.81,
      'value_plus_quality_option', 0.77,
      'flashy_trend_option', 0.09,
      'refine_before_committing', 0.58
    ),
    'behavior_patterns', jsonb_build_object(
      'verifies_before_next_step', 0.84,
      'stays_tidy_while_working', 0.79,
      'slows_down_under_pressure', 0.74,
      'asks_for_external_help', 0.24
    ),
    'exploitable_tendencies', jsonb_build_array(
      'will sacrifice speed for consistent output',
      'rarely chooses high-variance shortcuts',
      'prefers controlled sequences over improvisation',
      'defaults to quality plus value, not hype'
    ),
    'context_modifiers', jsonb_build_object(
      'familiar_setting', jsonb_build_object(
        'reliable_trusted_option', 0.86,
        'verifies_before_next_step', 0.88
      ),
      'time_pressure', jsonb_build_object(
        'slows_down_under_pressure', 0.79,
        'flashy_trend_option', 0.05
      ),
      'with_others_nearby', jsonb_build_object(
        'asks_for_external_help', 0.30,
        'stays_tidy_while_working', 0.75
      )
    )
  ),
  9,
  true
)
ON CONFLICT (slug) DO UPDATE
SET
  name = EXCLUDED.name,
  tagline = EXCLUDED.tagline,
  appearance = EXCLUDED.appearance,
  personality = EXCLUDED.personality,
  preferences = EXCLUDED.preferences,
  backstory = EXCLUDED.backstory,
  voice = EXCLUDED.voice,
  betting_signals = EXCLUDED.betting_signals,
  sort_order = EXCLUDED.sort_order,
  active = EXCLUDED.active;

-- Re-seed reference images idempotently.
DELETE FROM character_reference_images
WHERE character_id = (SELECT id FROM characters WHERE slug = 'malik');

INSERT INTO character_reference_images (
  character_id,
  image_storage_path,
  angle,
  is_primary,
  description,
  sort_order
)
SELECT
  c.id,
  v.image_storage_path,
  v.angle,
  v.is_primary,
  v.description,
  v.sort_order
FROM characters c
JOIN (
  VALUES
    ('characters/malik/front_sprinkling.jpg', 'front', true,  'Front angle, seasoning batter at bowl', 0),
    ('characters/malik/front_whisking_wide.jpg', 'front_wide', false, 'Front wide angle, whisking bowl on counter', 1),
    ('characters/malik/front_center_pose.jpg', 'front_center', false, 'Front centered angle, standing behind counter', 2),
    ('characters/malik/side_stove_pancakes.jpg', 'left_side', false, 'Left side angle at stove with pancakes visible', 3),
    ('characters/malik/front_ladling_pan.jpg', 'front_action', false, 'Front action angle, ladling batter into pan', 4)
) AS v(image_storage_path, angle, is_primary, description, sort_order)
  ON TRUE
WHERE c.slug = 'malik';

