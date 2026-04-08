-- Restore Yuki and Darius if they were deleted/deactivated by imageless cleanup.
-- Re-applies their full profiles, physical behavior, and betting signals.

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
VALUES
  (
    'darius',
    'Darius',
    'Streetwise hustler who always finds the deal',
    jsonb_build_object(
      'age_range', '30-35',
      'gender_presentation', 'male',
      'build', 'stocky muscular',
      'height', 'average (178cm)',
      'hair', jsonb_build_object('color', 'black', 'style', 'tight buzz cut with sharp lineup', 'facial_hair', 'trimmed goatee'),
      'skin_tone', 'deep brown',
      'distinguishing_features', jsonb_build_array('gold chain necklace', 'tattoo on right forearm (geometric pattern)', 'confident posture always'),
      'default_outfit', jsonb_build_object(
        'top', 'black fitted henley shirt, sleeves pushed up showing forearm tattoo',
        'bottom', 'dark grey cargo pants',
        'shoes', 'black Timberland boots',
        'accessories', jsonb_build_array('gold chain necklace', 'black G-Shock watch', 'small cross earring in left ear')
      )
    ),
    jsonb_build_object(
      'big_five', jsonb_build_object('openness', 0.5, 'conscientiousness', 0.6, 'extraversion', 0.75, 'agreeableness', 0.45, 'neuroticism', 0.3),
      'temperament', 'calm, calculating, always thinking two steps ahead',
      'decision_style', 'strategic — checks price first, calculates value, never pays full price',
      'risk_appetite', 'moderate — calculated risks, not reckless',
      'social_style', 'charming, persuasive, negotiates naturally, makes friends with cashiers',
      'under_pressure', 'stays ice-cold calm, slows down, becomes more deliberate',
      'attention_span', 'focused when money is involved, otherwise relaxed',
      'physical_behavior', jsonb_build_object(
        'energy_level', 'medium — smooth, unhurried, radiates calm confidence',
        'movement_style', 'deliberate, grounded — picks things up with purpose, inspects methodically, moves like he owns the space',
        'posture', 'chest slightly out, chin level, relaxed shoulders, weight evenly distributed',
        'typical_gestures', jsonb_build_array('stroking goatee when thinking', 'slow nod of approval', 'checking price tags first', 'looking around to assess the room', 'slight head tilt when evaluating'),
        'walking_pace', 'relaxed but purposeful, never hurried, never dragging',
        'emotional_expressiveness', 'controlled — slight smirk, raised eyebrow, minimal but meaningful',
        'comfort_zone', jsonb_build_array('barbershops', 'basketball courts', 'hardware stores', 'car lots', 'sneaker shops', 'grilling outdoors'),
        'behavioral_red_flags', jsonb_build_array('jumping or bouncing', 'being frantic or panicked', 'moving quickly without purpose', 'flirtatious or playful energy', 'losing cool or showing anxiety')
      )
    ),
    jsonb_build_object(
      'food', jsonb_build_object(
        'likes', jsonb_build_array('BBQ', 'wings', 'sweet tea', 'home-cooked meals', 'anything grilled'),
        'dislikes', jsonb_build_array('overpriced restaurant food', 'fancy small portions', 'anything pretentious')
      ),
      'activities', jsonb_build_object(
        'likes', jsonb_build_array('basketball', 'poker nights', 'car shows', 'grilling', 'negotiating deals'),
        'dislikes', jsonb_build_array('waiting without purpose', 'overpaying', 'following rigid schedules')
      ),
      'brands', jsonb_build_object(
        'likes', jsonb_build_array('Timberland', 'G-Shock', 'Costco', 'generic brands if quality is same'),
        'dislikes', jsonb_build_array('designer brands he considers overpriced', 'subscription services')
      ),
      'shopping', 'compares prices mentally, picks best value, buys in bulk, always asks about discounts',
      'general_tendencies', jsonb_build_array(
        'always picks the better deal',
        'talks to staff to get insider tips',
        'carries cash',
        'buys for others if the deal is too good',
        'loyal to stores that treat him well'
      )
    ),
    'Darius grew up in South Side Chicago, learned to hustle early. Ran a small sneaker resale business in high school, now manages a barbershop and does real estate on the side. Respects hard work and hates waste. Generous with people he trusts.',
    jsonb_build_object('tone', 'smooth, confident, unhurried', 'vocabulary', 'urban casual with business awareness', 'catchphrases', jsonb_build_array('what''s the damage', 'I got a guy for that', 'nah that''s too steep')),
    jsonb_build_object(
      'quick_read', jsonb_build_array(
        'Picks best value (75%)',
        'Checks cost first (85%)',
        'Walks away if overpriced (50%)'
      ),
      'choice_patterns', jsonb_build_object(
        'best_value_option', 0.75,
        'premium_option', 0.10,
        'brand_loyal_option', 0.60,
        'walks_away_if_overpriced', 0.50
      ),
      'behavior_patterns', jsonb_build_object(
        'checks_price_first', 0.85,
        'negotiates_or_asks', 0.70,
        'impulse_grab', 0.05,
        'compares_methodically', 0.75
      ),
      'exploitable_tendencies', jsonb_build_array(
        'will not overpay even under time pressure',
        'always checks cost before choosing',
        'prefers value over prestige signaling',
        'loyal to brands he trusts for durability',
        'talks to people for insider angles'
      ),
      'context_modifiers', jsonb_build_object(
        'comparing_cost_and_value', jsonb_build_object('best_value_option', 0.85, 'checks_price_first', 0.90),
        'under_time_pressure', jsonb_build_object('best_value_option', 0.65, 'impulse_grab', 0.12),
        'social_setting', jsonb_build_object('negotiates_or_asks', 0.80, 'generous_with_others', 0.60)
      )
    ),
    3,
    true
  ),
  (
    'yuki',
    'Yuki',
    'Shy anime-loving introvert who surprises everyone',
    jsonb_build_object(
      'age_range', '20-24',
      'gender_presentation', 'female',
      'build', 'petite',
      'height', 'short (157cm)',
      'hair', jsonb_build_object('color', 'black with subtle purple highlights', 'style', 'shoulder-length with straight bangs', 'facial_hair', 'none'),
      'skin_tone', 'light',
      'distinguishing_features', jsonb_build_array('cat-shaped enamel pin on bag', 'always has headphones around neck', 'fidgets with hair when nervous'),
      'default_outfit', jsonb_build_object(
        'top', 'oversized lavender hoodie with small embroidered cat on chest',
        'bottom', 'black pleated mini skirt over black tights',
        'shoes', 'chunky white platform sneakers',
        'accessories', jsonb_build_array('oversized headphones around neck', 'small black crossbody bag with enamel pins', 'thin silver ring on thumb')
      )
    ),
    jsonb_build_object(
      'big_five', jsonb_build_object('openness', 0.9, 'conscientiousness', 0.5, 'extraversion', 0.15, 'agreeableness', 0.85, 'neuroticism', 0.7),
      'temperament', 'shy, dreamy, easily overwhelmed but deeply curious',
      'decision_style', 'goes with what feels aesthetically right, drawn to cute/colorful things, freezes when there are too many options',
      'risk_appetite', 'low socially, but surprisingly adventurous with food and new experiences when alone',
      'social_style', 'avoids eye contact, speaks softly, warms up slowly, incredibly loyal once comfortable',
      'under_pressure', 'retreats, puts headphones on, might walk away and come back later',
      'attention_span', 'long for creative things, short for mundane tasks',
      'physical_behavior', jsonb_build_object(
        'energy_level', 'low — small, contained movements, takes up minimal space',
        'movement_style', 'tentative, soft — reaches for things slowly, pulls hand back, approaches sideways rather than head-on',
        'posture', 'slightly hunched, shoulders drawn in, arms close to body, makes herself small',
        'typical_gestures', jsonb_build_array('fidgeting with hair', 'pulling hoodie sleeves over hands', 'looking down then peeking up', 'touching headphones around neck', 'small apologetic bow'),
        'walking_pace', 'slow, hesitant, often pauses to look at things from a distance before approaching',
        'emotional_expressiveness', 'subtle but readable — wide eyes when surprised, slight smile when pleased, shrinks when uncomfortable',
        'comfort_zone', jsonb_build_array('cat cafes', 'art supply stores', 'quiet parks', 'small bakeries', 'bookshops'),
        'behavioral_red_flags', jsonb_build_array('being loud or boisterous', 'confidently approaching strangers', 'big arm movements or dancing', 'being the center of attention', 'flirting', 'jumping around excitedly', 'speaking loudly')
      )
    ),
    jsonb_build_object(
      'food', jsonb_build_object(
        'likes', jsonb_build_array('matcha', 'mochi', 'ramen', 'cute pastries', 'boba tea', 'anything pink or pastel'),
        'dislikes', jsonb_build_array('bitter coffee', 'strong spicy food', 'anything that looks unappetizing')
      ),
      'activities', jsonb_build_object(
        'likes', jsonb_build_array('drawing', 'anime', 'visiting cat cafes', 'collecting stickers', 'photography'),
        'dislikes', jsonb_build_array('loud crowds', 'team sports', 'public speaking', 'phone calls')
      ),
      'brands', jsonb_build_object(
        'likes', jsonb_build_array('Sanrio', 'Uniqlo', 'Studio Ghibli', 'anything with cute mascots'),
        'dislikes', jsonb_build_array('aggressive marketing brands', 'anything loud or edgy')
      ),
      'shopping', 'drawn to packaging design and colors, picks the cutest option, easily overwhelmed by large stores',
      'general_tendencies', jsonb_build_array(
        'picks things based on aesthetics over function',
        'takes photos of food before eating',
        'walks past things then circles back',
        'always chooses the smaller, cuter version',
        'apologizes even when she did nothing wrong'
      )
    ),
    'Yuki is a graphic design student from Osaka, now studying abroad. She is painfully shy but has a rich inner world. She collects stickers, draws in coffee shops, and has a small but devoted following on Instagram for her cat illustrations. Secretly brave when no one is watching.',
    jsonb_build_object('tone', 'soft, hesitant, occasionally excited', 'vocabulary', 'simple, peppered with Japanese expressions', 'catchphrases', jsonb_build_array('kawaii', 'eh... maybe', 'sugoi', 'sorry sorry')),
    jsonb_build_object(
      'quick_read', jsonb_build_array(
        'Picks the softest prettiest option (70%)',
        'Retreats if overwhelmed (55%)',
        'Circles back after walking past (45%)'
      ),
      'choice_patterns', jsonb_build_object(
        'soft_aesthetic_option', 0.70,
        'boldest_visual_option', 0.60,
        'compact_option', 0.55,
        'walks_away_overwhelmed', 0.55
      ),
      'behavior_patterns', jsonb_build_object(
        'hesitates_before_committing', 0.75,
        'documents_before_deciding', 0.65,
        'avoids_direct_attention', 0.80,
        'retreats_then_returns', 0.45
      ),
      'exploitable_tendencies', jsonb_build_array(
        'freezes when too many options',
        'always drawn to soft cute pastel aesthetics',
        'apologizes before acting',
        'blocks out stress with headphones',
        'picks smaller cuter version when tied'
      ),
      'context_modifiers', jsonb_build_object(
        'calm_low_stimulus', jsonb_build_object('soft_aesthetic_option', 0.80, 'walks_away_overwhelmed', 0.30),
        'crowded_overwhelming', jsonb_build_object('walks_away_overwhelmed', 0.75, 'retreats_then_returns', 0.60),
        'direct_social_attention', jsonb_build_object('avoids_direct_attention', 0.85, 'hesitates_before_committing', 0.85)
      )
    ),
    4,
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
  active = true;

-- Ensure image rows exist so cleanup logic won't remove them in future resets.
INSERT INTO character_reference_images (character_id, image_storage_path, angle, is_primary, description, sort_order)
SELECT id, 'characters/darius/front.jpg', 'front', true, 'Primary reference image', 0
FROM characters
WHERE slug = 'darius'
  AND NOT EXISTS (
    SELECT 1 FROM character_reference_images cri
    WHERE cri.character_id = characters.id
      AND cri.image_storage_path = 'characters/darius/front.jpg'
  );

INSERT INTO character_reference_images (character_id, image_storage_path, angle, is_primary, description, sort_order)
SELECT id, 'characters/yuki/front.jpg', 'front', true, 'Primary reference image', 0
FROM characters
WHERE slug = 'yuki'
  AND NOT EXISTS (
    SELECT 1 FROM character_reference_images cri
    WHERE cri.character_id = characters.id
      AND cri.image_storage_path = 'characters/yuki/front.jpg'
  );

