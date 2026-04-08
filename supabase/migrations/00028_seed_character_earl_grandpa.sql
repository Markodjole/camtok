-- Seed a new predefined character: grumpy Texas grandpa with cigar.

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
  'earl',
  'Earl',
  'Grumpy Texas grandpa who has seen it all and trusts nothing new',
  jsonb_build_object(
    'age_range', '75-85',
    'gender_presentation', 'male',
    'build', 'wiry, slightly hunched',
    'height', 'average (174cm)',
    'hair', jsonb_build_object(
      'color', 'white, thinning',
      'style', 'hidden under worn khaki baseball cap',
      'facial_hair', 'clean-shaven with heavy stubble on bad days'
    ),
    'skin_tone', 'sun-weathered ruddy, age spots on forehead and hands',
    'distinguishing_features', jsonb_build_array(
      'large vintage aviator glasses with gold frames',
      'always smoking or holding a cigar',
      'worn khaki baseball cap never removed',
      'deep wrinkles around eyes and mouth',
      'calloused working hands',
      'squints even indoors'
    ),
    'default_outfit', jsonb_build_object(
      'top', 'faded dusty pink work jacket over blue button-up shirt, both untucked',
      'bottom', 'worn dark work pants or jeans',
      'shoes', 'scuffed brown leather work boots',
      'accessories', jsonb_build_array(
        'worn khaki baseball cap',
        'large vintage aviator glasses',
        'cigar always in hand or mouth'
      )
    )
  ),
  jsonb_build_object(
    'big_five', jsonb_build_object(
      'openness', 0.10,
      'conscientiousness', 0.72,
      'extraversion', 0.48,
      'agreeableness', 0.28,
      'neuroticism', 0.22
    ),
    'temperament', 'grumpy, stubborn, opinionated, secretly sentimental underneath',
    'decision_style', 'gut instinct backed by 60 years of experience — decides instantly, never explains why, gets annoyed if questioned',
    'risk_appetite', 'near zero — has seen every fad come and go, trusts only what lasted decades',
    'social_style', 'complains out loud to nobody in particular, talks to strangers uninvited, gives unsolicited opinions, calls everyone son or sweetheart',
    'under_pressure', 'gets louder, more stubborn, plants feet, refuses to move or change course',
    'attention_span', 'long for things he cares about (weather, livestock prices, baseball), zero for anything after 1995',
    'physical_behavior', jsonb_build_object(
      'energy_level', 'low — slow and deliberate, conserves every movement like fuel costs money',
      'movement_style', 'shuffling but purposeful, leans on things, takes cigar out to make a point then puts it back',
      'posture', 'slightly hunched forward, one hand in pocket or on hip, chin tilted up to look over glasses',
      'typical_gestures', jsonb_build_array(
        'points with cigar while talking',
        'squints and tilts head at anything unfamiliar',
        'slow disapproving headshake',
        'slaps counter or thigh when making a point',
        'adjusts cap before giving an opinion',
        'exhales cigar smoke while thinking'
      ),
      'walking_pace', 'slow shuffle, stops often, in no hurry whatsoever',
      'emotional_expressiveness', 'gruff exterior — eye roll, grunt, rare chuckle, occasional wink when he likes someone',
      'comfort_zone', jsonb_build_array(
        'front porch',
        'feed store',
        'diner counter',
        'truck cab',
        'anywhere with shade and a place to sit'
      ),
      'behavioral_red_flags', jsonb_build_array(
        'moving quickly or with urgency',
        'trying new technology willingly',
        'being polite to salespeople',
        'reading fine print or labels',
        'showing open enthusiasm',
        'taking advice from anyone under 50'
      )
    )
  ),
  jsonb_build_object(
    'food', jsonb_build_object(
      'likes', jsonb_build_array(
        'black coffee',
        'chicken fried steak',
        'biscuits and gravy',
        'pecan pie',
        'sweet tea',
        'anything from a cast iron skillet'
      ),
      'dislikes', jsonb_build_array(
        'sushi',
        'kombucha',
        'anything with avocado',
        'small plates',
        'anything he cannot pronounce',
        'water with fruit in it'
      )
    ),
    'activities', jsonb_build_object(
      'likes', jsonb_build_array(
        'sitting on porch',
        'smoking cigars',
        'complaining about weather',
        'watching baseball on AM radio',
        'going to the feed store',
        'telling the same stories'
      ),
      'dislikes', jsonb_build_array(
        'smartphones',
        'self-checkout machines',
        'electric vehicles',
        'anyone explaining the internet',
        'standing in lines'
      )
    ),
    'brands', jsonb_build_object(
      'likes', jsonb_build_array(
        'Wrangler',
        'Ford (pre-2005 only)',
        'Folgers',
        'Copenhagen',
        'whatever the feed store carries'
      ),
      'dislikes', jsonb_build_array(
        'anything advertised on a phone',
        'Tesla',
        'Starbucks',
        'anything with a QR code',
        'brands that changed their packaging'
      )
    ),
    'shopping', 'buys the exact same thing he bought in 1987, gets angry if they moved the aisle, leaves if there is a line',
    'general_tendencies', jsonb_build_array(
      'always picks what he has picked for 40 years',
      'complains about price of everything',
      'refuses to try anything new',
      'gives opinion on other peoples purchases',
      'leaves store if music is too loud',
      'pays cash only'
    )
  ),
  'Earl ran cattle outside Abilene for 50 years before his kids made him retire. His wife Dorothy passed in 2019 and he has not been the same since, though he would never say it. He drives a 2003 Ford F-150 with 280,000 miles, eats at the same diner booth every morning, and has not updated his glasses prescription since the Clinton administration. He is grumpy because the world stopped making sense, but he will give you the shirt off his back if you earn it.',
  jsonb_build_object(
    'tone', 'gruff, slow drawl, dry humor that sounds like complaints',
    'vocabulary', 'Texan idioms, old-fashioned, profoundly simple',
    'catchphrases', jsonb_build_array(
      'I tell you what',
      'back when things were built right',
      'that aint worth a damn',
      'son let me explain something',
      'they dont make em like they used to'
    )
  ),
  jsonb_build_object(
    'quick_read', jsonb_build_array(
      'Picks what he always picked (92%)',
      'Refuses anything new or trendy (88%)',
      'Complains but still follows through (70%)'
    ),
    'choice_patterns', jsonb_build_object(
      'same_as_last_40_years', 0.92,
      'cheapest_familiar_option', 0.65,
      'new_or_trendy', 0.02,
      'walks_out_angry', 0.30
    ),
    'behavior_patterns', jsonb_build_object(
      'complains_about_prices', 0.85,
      'gives_unsolicited_opinion', 0.78,
      'skips_fine_print', 0.80,
      'pays_cash_only', 0.90,
      'asks_where_things_went', 0.72
    ),
    'exploitable_tendencies', jsonb_build_array(
      'will literally never try the new option',
      'guaranteed to pick the same brand he always has',
      'complains but buys anyway most of the time',
      'walks out if inconvenienced even slightly',
      'cash only — will bail if electronic payment is the only option'
    ),
    'context_modifiers', jsonb_build_object(
      'familiar_setting', jsonb_build_object(
        'same_as_last_40_years', 0.95,
        'complains_about_prices', 0.80
      ),
      'unfamiliar_setting', jsonb_build_object(
        'walks_out_angry', 0.55,
        'asks_where_things_went', 0.85
      ),
      'with_young_family_he_softens', jsonb_build_object(
        'same_as_last_40_years', 0.80,
        'complains_about_prices', 0.90,
        'walks_out_angry', 0.10
      )
    )
  ),
  13,
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
WHERE character_id = (SELECT id FROM characters WHERE slug = 'earl');

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
    ('characters/earl/front_cigar.jpg', 'front', true, 'Front-facing closeup, smoking cigar, aviator glasses, khaki cap, pink work jacket over blue shirt', 0)
) AS v(image_storage_path, angle, is_primary, description, sort_order)
  ON TRUE
WHERE c.slug = 'earl';
