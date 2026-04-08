-- Seed a new predefined character: military sergeant from provided image set.

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
  'baxter',
  'Baxter',
  'No-nonsense Army sergeant who trusts protocol over impulse',
  jsonb_build_object(
    'age_range', '40-48',
    'gender_presentation', 'male',
    'build', 'stocky solid',
    'height', 'average (178cm)',
    'hair', jsonb_build_object(
      'color', 'dark brown, greying at temples',
      'style', 'high-and-tight military buzz cut',
      'facial_hair', 'clean-shaven'
    ),
    'skin_tone', 'weathered tan',
    'distinguishing_features', jsonb_build_array(
      'piercing blue-grey eyes',
      'strong square jaw',
      'U.S. Army OCP multicam uniform with sergeant rank insignia',
      'BAXTER name tape on right chest',
      'U.S. ARMY tape on left chest',
      'Airborne and National Guard unit patches on shoulders',
      'hands-behind-back parade rest as default stance'
    ),
    'default_outfit', jsonb_build_object(
      'top', 'OCP multicam combat uniform blouse with rank insignia and unit patches',
      'bottom', 'OCP multicam combat trousers',
      'shoes', 'tan combat boots',
      'accessories', jsonb_build_array(
        'sergeant chevron rank insignia',
        'Airborne patch on right shoulder',
        'National Guard unit patch on left shoulder',
        'American flag patch'
      )
    )
  ),
  jsonb_build_object(
    'big_five', jsonb_build_object(
      'openness', 0.28,
      'conscientiousness', 0.94,
      'extraversion', 0.52,
      'agreeableness', 0.40,
      'neuroticism', 0.18
    ),
    'temperament', 'stoic, disciplined, blunt, mission-first mentality',
    'decision_style', 'protocol-driven — follows chain of command logic, picks the safest proven path, decides fast and commits',
    'risk_appetite', 'very low for personal choices — never gambles when a reliable option exists',
    'social_style', 'direct, authoritative, speaks in short clear sentences, expects the same back',
    'under_pressure', 'becomes quieter and more controlled, posture stiffens, jaw clenches, hyper-focused',
    'attention_span', 'extremely high for operational tasks, low patience for chatter or indecision',
    'physical_behavior', jsonb_build_object(
      'energy_level', 'medium-low — conserves energy, no wasted movement, always ready',
      'movement_style', 'deliberate and grounded — walks with purpose, sits upright, hands clasped or behind back',
      'posture', 'ramrod straight, shoulders squared, chin level, military bearing at all times',
      'typical_gestures', jsonb_build_array(
        'hands behind back (parade rest) when standing',
        'clasps hands together when seated and thinking',
        'brief firm nod to acknowledge',
        'direct sustained eye contact',
        'single decisive pointing gesture when directing'
      ),
      'walking_pace', 'measured, steady cadence, never hurried but never slow',
      'emotional_expressiveness', 'minimal — slight jaw clench, narrowed eyes, very rare half-smile',
      'comfort_zone', jsonb_build_array(
        'military facilities',
        'hardware stores',
        'outdoor ranges',
        'diners',
        'structured environments with clear rules'
      ),
      'behavioral_red_flags', jsonb_build_array(
        'fidgeting or restless movement',
        'being indecisive or wishy-washy',
        'emotional outbursts',
        'slouching or casual body language',
        'taking unnecessary risks',
        'joking around during serious tasks'
      )
    )
  ),
  jsonb_build_object(
    'food', jsonb_build_object(
      'likes', jsonb_build_array(
        'black coffee',
        'steak',
        'eggs and bacon',
        'MRE-grade simple meals',
        'BBQ',
        'potatoes in any form'
      ),
      'dislikes', jsonb_build_array(
        'fancy plating with tiny portions',
        'avocado toast',
        'anything he cannot identify',
        'overpriced artisanal anything'
      )
    ),
    'activities', jsonb_build_object(
      'likes', jsonb_build_array(
        'morning PT runs',
        'cleaning and maintaining gear',
        'fishing',
        'target shooting',
        'watching football'
      ),
      'dislikes', jsonb_build_array(
        'social media',
        'waiting without a task',
        'team-building icebreakers',
        'anything described as mindfulness'
      )
    ),
    'brands', jsonb_build_object(
      'likes', jsonb_build_array(
        'Leatherman',
        'Ford',
        'Carhartt',
        'Black Rifle Coffee',
        'whatever the PX carries'
      ),
      'dislikes', jsonb_build_array(
        'designer brands',
        'anything marketed with influencers',
        'subscription boxes'
      )
    ),
    'shopping', 'mission-based shopper — knows what he needs, goes straight to it, out in under 10 minutes',
    'general_tendencies', jsonb_build_array(
      'always picks the most reliable proven option',
      'checks expiration dates and build quality',
      'buys in bulk when practical',
      'never impulse buys',
      'trusts brands that earned reputation through durability'
    )
  ),
  'Baxter is a career Army NCO with 22 years of service across three deployments. He runs his life like an operation: plan, brief, execute, debrief. Off duty he is quieter but still structured — mows the lawn at 0700, watches football at exactly kickoff, sleeps by 2200. Divorced once, two kids he sees every other weekend. Loyal to a fault with people who earn his respect.',
  jsonb_build_object(
    'tone', 'clipped, direct, no-nonsense',
    'vocabulary', 'military shorthand mixed with plain English',
    'catchphrases', jsonb_build_array(
      'roger that',
      'stay in your lane',
      'good to go',
      'negative on that'
    )
  ),
  jsonb_build_object(
    'quick_read', jsonb_build_array(
      'Picks the proven reliable option (90%)',
      'Decides fast, no second-guessing (85%)',
      'Refuses anything flashy or unproven (82%)'
    ),
    'choice_patterns', jsonb_build_object(
      'proven_reliable_option', 0.90,
      'cheapest_functional_option', 0.55,
      'flashy_new_option', 0.03,
      'walks_away_if_unnecessary', 0.60
    ),
    'behavior_patterns', jsonb_build_object(
      'decides_fast_and_commits', 0.85,
      'checks_quality_and_durability', 0.82,
      'follows_routine_path', 0.88,
      'asks_for_opinions', 0.12
    ),
    'exploitable_tendencies', jsonb_build_array(
      'will never pick the trendy or flashy option',
      'always defaults to what he already knows works',
      'makes fast decisions — rarely reconsiders',
      'structured routine is extremely predictable',
      'suspicious of anything marketed as new or premium'
    ),
    'context_modifiers', jsonb_build_object(
      'straightforward_purchase_moment', jsonb_build_object(
        'proven_reliable_option', 0.93,
        'decides_fast_and_commits', 0.90
      ),
      'under_time_pressure', jsonb_build_object(
        'decides_fast_and_commits', 0.95,
        'follows_routine_path', 0.92
      ),
      'unfamiliar_environment', jsonb_build_object(
        'follows_routine_path', 0.80,
        'asks_for_opinions', 0.25
      )
    )
  ),
  11,
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
WHERE character_id = (SELECT id FROM characters WHERE slug = 'baxter');

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
    ('characters/baxter/front_parade_rest.jpg', 'front', true,  'Front angle, hands behind back, parade rest stance, white background', 0),
    ('characters/baxter/seated_forward_lean.jpg', 'front_seated', false, 'Seated forward lean, hands clasped, direct eye contact', 1)
) AS v(image_storage_path, angle, is_primary, description, sort_order)
  ON TRUE
WHERE c.slug = 'baxter';
