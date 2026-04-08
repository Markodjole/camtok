-- Seed a new predefined character: young trendy girl in clothing store.

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
  'lila',
  'Lila',
  'Indecisive teen shopper who picks vibes over logic',
  jsonb_build_object(
    'age_range', '14-17',
    'gender_presentation', 'female',
    'build', 'slim tall for age',
    'height', 'above average (170cm)',
    'hair', jsonb_build_object(
      'color', 'light auburn / strawberry brown',
      'style', 'very long straight, loose past waist, no bangs',
      'facial_hair', 'none'
    ),
    'skin_tone', 'fair with warm undertone',
    'distinguishing_features', jsonb_build_array(
      'very long straight hair past waist',
      'hand-on-head pose when browsing or thinking',
      'relaxed slightly bored default expression',
      'small white scrunchie on wrist'
    ),
    'default_outfit', jsonb_build_object(
      'top', 'white tie-dye t-shirt with pastel pink and blue splotches',
      'bottom', 'bright pink high-waisted straight-leg jeans',
      'shoes', 'white low-top sneakers',
      'accessories', jsonb_build_array(
        'white scrunchie on wrist',
        'no jewelry visible'
      )
    )
  ),
  jsonb_build_object(
    'big_five', jsonb_build_object(
      'openness', 0.82,
      'conscientiousness', 0.22,
      'extraversion', 0.60,
      'agreeableness', 0.68,
      'neuroticism', 0.58
    ),
    'temperament', 'dreamy, indecisive, mood-driven, easily swayed by aesthetics',
    'decision_style', 'vibes-first — picks whatever feels right in the moment, changes mind multiple times, often leaves empty-handed',
    'risk_appetite', 'moderate — will try bold colors and styles but avoids commitment on big purchases',
    'social_style', 'quiet confidence among peers, mirrors friends choices, seeks approval through shared taste',
    'under_pressure', 'shuts down, puts item back, walks to another section, avoids eye contact with staff',
    'attention_span', 'short for anything not visually interesting, long for browsing and touching fabrics',
    'physical_behavior', jsonb_build_object(
      'energy_level', 'medium-low — slow browsing energy, moves through racks lazily',
      'movement_style', 'languid, drifting — touches things as she passes, picks up and puts back constantly',
      'posture', 'relaxed, one hip out, hand on head or playing with hair when thinking',
      'typical_gestures', jsonb_build_array(
        'runs hand through hair while deciding',
        'holds garment up against body in mirror',
        'puts item back then circles back to it',
        'checks phone between racks',
        'slight head tilt when comparing two items'
      ),
      'walking_pace', 'slow meandering, no fixed route through store',
      'emotional_expressiveness', 'moderate — slight pout when unsure, eyes widen at something she likes, shrugs often',
      'comfort_zone', jsonb_build_array(
        'clothing stores',
        'mall food courts',
        'boba shops',
        'bedrooms with friends',
        'Instagram and TikTok'
      ),
      'behavioral_red_flags', jsonb_build_array(
        'making fast decisive purchases',
        'sticking to a shopping list',
        'ignoring aesthetics for practicality',
        'being assertive with store staff',
        'wearing plain or neutral outfits',
        'sitting still for long periods'
      )
    )
  ),
  jsonb_build_object(
    'food', jsonb_build_object(
      'likes', jsonb_build_array(
        'boba tea',
        'acai bowls',
        'fries',
        'iced matcha',
        'anything pink or photogenic',
        'gummy candy'
      ),
      'dislikes', jsonb_build_array(
        'anything healthy-looking but boring',
        'coffee (too bitter)',
        'salads without toppings',
        'anything her parents would order'
      )
    ),
    'activities', jsonb_build_object(
      'likes', jsonb_build_array(
        'shopping with friends',
        'TikTok scrolling',
        'trying on outfits',
        'making mood boards',
        'thrifting'
      ),
      'dislikes', jsonb_build_array(
        'homework',
        'waiting in lines',
        'carrying heavy bags',
        'stores with no music'
      )
    ),
    'brands', jsonb_build_object(
      'likes', jsonb_build_array(
        'Zara',
        'Brandy Melville',
        'Converse',
        'Shein (guilty)',
        'whatever is trending on TikTok this week'
      ),
      'dislikes', jsonb_build_array(
        'mom brands',
        'anything from 2 seasons ago',
        'plain basics without personality'
      )
    ),
    'shopping', 'browses endlessly, tries on 10 items, buys 0-2, returns half next week',
    'general_tendencies', jsonb_build_array(
      'picks bold colors over neutrals',
      'changes mind at least 3 times per store visit',
      'holds items for 20 minutes then puts them back',
      'influenced by what friends or TikTok recommend',
      'gravitates to the newest arrivals section first'
    )
  ),
  'Lila is a high school sophomore who lives for weekend mall trips and outfit-of-the-day posts. She has strong opinions about aesthetics but weak commitment to purchases. Her room is a mix of clothes with tags still on and thrift finds she is proud of. She makes decisions based on how something makes her feel in the moment, not whether she needs it.',
  jsonb_build_object(
    'tone', 'casual, slightly dramatic, valley-girl adjacent',
    'vocabulary', 'gen-alpha slang, TikTok references, elongated words',
    'catchphrases', jsonb_build_array(
      'wait thats actually cute',
      'I literally cannot decide',
      'okaaay but in what color',
      'nah its giving nothing'
    )
  ),
  jsonb_build_object(
    'quick_read', jsonb_build_array(
      'Picks based on vibes not logic (78%)',
      'Changes mind at least once (72%)',
      'Walks away without committing (45%)'
    ),
    'choice_patterns', jsonb_build_object(
      'boldest_color_option', 0.68,
      'trending_option', 0.72,
      'practical_option', 0.12,
      'leaves_empty_handed', 0.45,
      'buys_then_returns', 0.35
    ),
    'behavior_patterns', jsonb_build_object(
      'explores_by_touch_while_deciding', 0.82,
      'changes_mind_multiple_times', 0.72,
      'checks_phone_between_decisions', 0.75,
      'asks_friend_opinion', 0.65,
      'last_minute_add_on_near_finish', 0.40
    ),
    'exploitable_tendencies', jsonb_build_array(
      'almost never picks the practical option',
      'very high chance of changing mind mid-decision',
      'bold colors and trending items win over everything',
      'will bail if the last step feels slow or annoying',
      'heavily influenced by whatever she saw online that day'
    ),
    'context_modifiers', jsonb_build_object(
      'with_friends', jsonb_build_object(
        'trending_option', 0.80,
        'asks_friend_opinion', 0.85,
        'leaves_empty_handed', 0.30
      ),
      'alone', jsonb_build_object(
        'changes_mind_multiple_times', 0.80,
        'leaves_empty_handed', 0.55,
        'checks_phone_between_decisions', 0.85
      ),
      'high_excitement_limited_deal', jsonb_build_object(
        'last_minute_add_on_near_finish', 0.60,
        'boldest_color_option', 0.75,
        'leaves_empty_handed', 0.20
      )
    )
  ),
  12,
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
WHERE character_id = (SELECT id FROM characters WHERE slug = 'lila');

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
    ('characters/lila/front_store_pose.jpg', 'front', true, 'Front angle, hand on head pose, clothing store with denim racks behind', 0)
) AS v(image_storage_path, angle, is_primary, description, sort_order)
  ON TRUE
WHERE c.slug = 'lila';
