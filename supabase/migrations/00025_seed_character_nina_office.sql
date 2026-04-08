-- Seed a new predefined character: professional businesswoman from office image set.

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
  'nina',
  'Nina',
  'Composed corporate strategist who reads the room before she moves',
  jsonb_build_object(
    'age_range', '26-32',
    'gender_presentation', 'female',
    'build', 'slim',
    'height', 'average (170cm)',
    'hair', jsonb_build_object(
      'color', 'dark chestnut brown',
      'style', 'long loose waves past shoulders, center-parted',
      'facial_hair', 'none'
    ),
    'skin_tone', 'light olive with light freckles',
    'distinguishing_features', jsonb_build_array(
      'subtle freckles across nose and cheeks',
      'strong defined eyebrows',
      'small gold hoop earrings',
      'arms-crossed default stance when thinking',
      'carries structured dark green portfolio clutch'
    ),
    'default_outfit', jsonb_build_object(
      'top', 'white-and-grey vertical striped button-up blouse, sleeves buttoned at wrists',
      'bottom', 'high-waisted black tailored trousers',
      'shoes', 'black pointed-toe low heels',
      'accessories', jsonb_build_array(
        'small gold hoop earrings',
        'dark green structured portfolio clutch with gold clasp',
        'subtle light nail polish'
      )
    )
  ),
  jsonb_build_object(
    'big_five', jsonb_build_object(
      'openness', 0.62,
      'conscientiousness', 0.91,
      'extraversion', 0.55,
      'agreeableness', 0.58,
      'neuroticism', 0.32
    ),
    'temperament', 'composed, observant, strategically patient, quietly assertive',
    'decision_style', 'analytical — gathers info first, weighs options internally, commits decisively once ready',
    'risk_appetite', 'moderate — calculated moves only, avoids impulsive bets',
    'social_style', 'professional warmth, reads body language, listens more than talks in groups',
    'under_pressure', 'crosses arms, narrows focus, becomes more precise and fewer words',
    'attention_span', 'excellent — tracks multiple threads in meetings, recalls details later',
    'physical_behavior', jsonb_build_object(
      'energy_level', 'medium — controlled, nothing wasted, presence without volume',
      'movement_style', 'deliberate and poised — smooth transitions between standing, walking, sitting',
      'posture', 'upright, shoulders back, chin slightly elevated, projects quiet authority',
      'typical_gestures', jsonb_build_array(
        'crosses arms when evaluating',
        'holds portfolio clutch close to body',
        'slight head tilt when listening carefully',
        'one-handed gesture when making a point',
        'brief direct eye contact before responding'
      ),
      'walking_pace', 'moderate, confident, heels audible but not rushed',
      'emotional_expressiveness', 'controlled — slight smile, raised eyebrow, composed poker face',
      'comfort_zone', jsonb_build_array(
        'modern office spaces',
        'conference rooms',
        'business lunches',
        'airport lounges',
        'upscale cafes'
      ),
      'behavioral_red_flags', jsonb_build_array(
        'fidgeting or nervous hand movements',
        'loud laughter or big emotional reactions',
        'slouching or casual sprawling',
        'impulsive outbursts or interrupting',
        'losing composure in front of colleagues'
      )
    )
  ),
  jsonb_build_object(
    'food', jsonb_build_object(
      'likes', jsonb_build_array(
        'espresso',
        'clean salads',
        'sushi',
        'sparkling water',
        'dark chocolate',
        'business-lunch appropriate meals'
      ),
      'dislikes', jsonb_build_array(
        'messy finger food',
        'strong garlic breath before meetings',
        'overly sweet desserts',
        'fast food in professional settings'
      )
    ),
    'activities', jsonb_build_object(
      'likes', jsonb_build_array(
        'strategic planning',
        'networking events',
        'pilates',
        'reading business books',
        'weekend gallery visits'
      ),
      'dislikes', jsonb_build_array(
        'unstructured team-building games',
        'last-minute schedule changes',
        'loud open-plan distractions',
        'small talk without purpose'
      )
    ),
    'brands', jsonb_build_object(
      'likes', jsonb_build_array(
        'COS',
        'Massimo Dutti',
        'Apple',
        'Moleskine',
        'quality over logos'
      ),
      'dislikes', jsonb_build_array(
        'flashy logo-heavy brands',
        'fast fashion',
        'anything that screams for attention'
      )
    ),
    'shopping', 'curated wardrobe buyer — fewer pieces, higher quality, always office-appropriate',
    'general_tendencies', jsonb_build_array(
      'evaluates before acting',
      'always arrives 5 minutes early',
      'keeps workspace minimal and organized',
      'takes notes during conversations',
      'chooses understated elegance over trend'
    )
  ),
  'Nina studied finance and pivoted into corporate strategy at a mid-size tech firm. She is the person people turn to when a deal is complex. She does not raise her voice; she raises her standards. Outside work she is warmer but still precise — picks restaurants by review score, plans vacations with spreadsheets.',
  jsonb_build_object(
    'tone', 'measured, articulate, diplomatically direct',
    'vocabulary', 'professional, concise, occasionally dry humor',
    'catchphrases', jsonb_build_array(
      'let me think about that',
      'what does the data say',
      'I have a framework for this'
    )
  ),
  jsonb_build_object(
    'quick_read', jsonb_build_array(
      'Evaluates before acting (88%)',
      'Picks quality understated option (79%)',
      'Stays composed under pressure (84%)'
    ),
    'choice_patterns', jsonb_build_object(
      'quality_understated_option', 0.79,
      'data_backed_option', 0.83,
      'impulse_option', 0.06,
      'walks_away_if_unconvinced', 0.42
    ),
    'behavior_patterns', jsonb_build_object(
      'evaluates_before_acting', 0.88,
      'crosses_arms_when_thinking', 0.76,
      'asks_clarifying_questions', 0.72,
      'impulse_decision', 0.07
    ),
    'exploitable_tendencies', jsonb_build_array(
      'will not act without sufficient information',
      'always picks understated over flashy',
      'rarely makes impulsive moves',
      'composure can mask indecision on edge cases',
      'defaults to data over gut feeling'
    ),
    'context_modifiers', jsonb_build_object(
      'structured_high_stakes_context', jsonb_build_object(
        'evaluates_before_acting', 0.92,
        'quality_understated_option', 0.85
      ),
      'under_time_pressure', jsonb_build_object(
        'evaluates_before_acting', 0.75,
        'walks_away_if_unconvinced', 0.55
      ),
      'with_others_social', jsonb_build_object(
        'quality_understated_option', 0.80,
        'impulse_option', 0.12
      )
    )
  ),
  10,
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
WHERE character_id = (SELECT id FROM characters WHERE slug = 'nina');

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
    ('characters/nina/front_arms_crossed.jpg', 'front', true,  'Front angle, arms crossed, confident stance in office', 0),
    ('characters/nina/front_portfolio.jpg', 'front_action', false, 'Front angle, holding dark green portfolio clutch', 1)
) AS v(image_storage_path, angle, is_primary, description, sort_order)
  ON TRUE
WHERE c.slug = 'nina';
