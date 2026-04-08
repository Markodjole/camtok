-- Seed a new predefined character: heavy-set street guy with old car backdrop.

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
  'viktor',
  'Viktor',
  'Streetwise big man who acts tough but calculates every move',
  jsonb_build_object(
    'age_range', '30-38',
    'gender_presentation', 'male',
    'build', 'heavy-set stocky',
    'height', 'average (176cm)',
    'hair', jsonb_build_object(
      'color', 'dark brown/black',
      'style', 'receding hairline with very short top',
      'facial_hair', 'full short beard and mustache'
    ),
    'skin_tone', 'light olive',
    'distinguishing_features', jsonb_build_array(
      'broad frame with pronounced belly',
      'close-cropped beard framing jawline',
      'often holds a small glass while talking',
      'head tilt and side-eye when judging people',
      'relaxed but dominant wide-leg stance'
    ),
    'default_outfit', jsonb_build_object(
      'top', 'open short-sleeve blue patterned overshirt over white henley/tank base layer',
      'bottom', 'dark navy cargo shorts',
      'shoes', 'black high-top sneakers with red accents',
      'accessories', jsonb_build_array(
        'simple chain necklace',
        'small drinking glass usually in right hand'
      )
    )
  ),
  jsonb_build_object(
    'big_five', jsonb_build_object(
      'openness', 0.34,
      'conscientiousness', 0.57,
      'extraversion', 0.74,
      'agreeableness', 0.36,
      'neuroticism', 0.46
    ),
    'temperament', 'confident, territorial, sarcastic, opportunistic',
    'decision_style', 'street-logic first — evaluates people quickly, chooses moves that protect status and comfort',
    'risk_appetite', 'moderate-high socially, moderate financially',
    'social_style', 'loud with strangers, warm with his own circle, tests people before trusting',
    'under_pressure', 'gets confrontational tone but still computes angles before committing',
    'attention_span', 'short for boring tasks, sharp for social power dynamics and deal opportunities',
    'physical_behavior', jsonb_build_object(
      'energy_level', 'medium-low — slow heavy movements until motivated',
      'movement_style', 'grounded and deliberate, takes space, uses body positioning to dominate interaction',
      'posture', 'forward shoulder lean, chin up, chest out, feet planted wide',
      'typical_gestures', jsonb_build_array(
        'holds drink while talking',
        'slow head tilt with skeptical expression',
        'points with chin instead of finger',
        'brief smirk before disagreeing',
        'hands in pockets while observing'
      ),
      'walking_pace', 'slow confident pace, rarely hurries',
      'emotional_expressiveness', 'visible irritation and amusement; rarely shows fear',
      'comfort_zone', jsonb_build_array(
        'street-side gatherings',
        'garage forecourts',
        'small local bars',
        'car meet spots',
        'neighborhood courtyards'
      ),
      'behavioral_red_flags', jsonb_build_array(
        'submissive body language',
        'rushed anxious movements',
        'formal corporate politeness',
        'public vulnerability',
        'being ignored without reaction'
      )
    )
  ),
  jsonb_build_object(
    'food', jsonb_build_object(
      'likes', jsonb_build_array(
        'grilled meat',
        'kebabs',
        'fried potatoes',
        'cola',
        'late-night street food',
        'strong coffee'
      ),
      'dislikes', jsonb_build_array(
        'small gourmet portions',
        'salads as main meal',
        'expensive trendy cafes'
      )
    ),
    'activities', jsonb_build_object(
      'likes', jsonb_build_array(
        'car talk',
        'watching fights/football',
        'hanging with neighborhood friends',
        'casual gambling',
        'barbecuing'
      ),
      'dislikes', jsonb_build_array(
        'formal meetings',
        'strict schedules',
        'being told what to do'
      )
    ),
    'brands', jsonb_build_object(
      'likes', jsonb_build_array(
        'Adidas',
        'Lada nostalgia',
        'local no-name brands with good value',
        'cheap durable gear'
      ),
      'dislikes', jsonb_build_array(
        'luxury brands for status only',
        'fragile premium products'
      )
    ),
    'shopping', 'buys by value and image: if it looks tough and lasts, he buys; if overpriced, he mocks and walks',
    'general_tendencies', jsonb_build_array(
      'judges quickly by appearance and tone',
      'prefers familiar places and known faces',
      'switches to humor when uncomfortable',
      'protects his social status in group settings',
      'acts impulsive but often has backup plan'
    )
  ),
  'Viktor grew up in a rough industrial neighborhood where social respect mattered more than credentials. He worked odd jobs around auto yards and delivery, learned to read people fast, and built his identity around never looking weak in public. Beneath the rough style he is loyal to family and unexpectedly generous when someone proves real.',
  jsonb_build_object(
    'tone', 'rough casual with dry sarcasm',
    'vocabulary', 'street slang, short direct sentences',
    'catchphrases', jsonb_build_array(
      'easy there',
      'dont play smart with me',
      'we keep it simple',
      'show me, dont tell me'
    )
  ),
  jsonb_build_object(
    'quick_read', jsonb_build_array(
      'Protects status in social situations (81%)',
      'Chooses value+tough look over premium labels (76%)',
      'Walks away when he feels disrespected (58%)'
    ),
    'choice_patterns', jsonb_build_object(
      'value_tough_option', 0.76,
      'status_protective_option', 0.81,
      'premium_showoff_option', 0.14,
      'walks_away_if_disrespected', 0.58
    ),
    'behavior_patterns', jsonb_build_object(
      'tests_people_first', 0.72,
      'sarcastic_deflection', 0.67,
      'slow_deliberate_presence', 0.79,
      'quick_temper_response', 0.38
    ),
    'exploitable_tendencies', jsonb_build_array(
      'reacts strongly to disrespect cues',
      'picks familiar value options over unknown premium',
      'prefers social dominance over compromise',
      'rarely chooses subtle or polished style'
    ),
    'context_modifiers', jsonb_build_object(
      'with_friends', jsonb_build_object(
        'status_protective_option', 0.88,
        'sarcastic_deflection', 0.75
      ),
      'alone', jsonb_build_object(
        'value_tough_option', 0.82,
        'walks_away_if_disrespected', 0.42
      ),
      'under_pressure', jsonb_build_object(
        'quick_temper_response', 0.52,
        'status_protective_option', 0.86
      )
    )
  ),
  14,
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
WHERE character_id = (SELECT id FROM characters WHERE slug = 'viktor');

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
    ('characters/viktor/front_fullbody_street.jpg', 'front_full', true, 'Front full-body stance in street with vintage car backdrop', 0),
    ('characters/viktor/three_quarter_close_street.jpg', 'three_quarter', false, 'Three-quarter close angle holding drink, street wall + bike backdrop', 1)
) AS v(image_storage_path, angle, is_primary, description, sort_order)
  ON TRUE
WHERE c.slug = 'viktor';

