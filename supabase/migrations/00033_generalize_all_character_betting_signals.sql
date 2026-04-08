-- Scene-agnostic betting_signals for every character: UI labels derive from keys/strings.
-- Replaces shopping/office/kitchen-specific context keys and pattern names.

-- Original 8 (from revised 00022)
UPDATE characters SET betting_signals = jsonb_build_object(
  'quick_read', jsonb_build_array(
    'Grabs the first option that pops (80%)',
    'Picks the louder flashier choice (75%)',
    'Loses patience fast (70%)'
  ),
  'choice_patterns', jsonb_build_object(
    'flashiest_option', 0.75,
    'cheapest_option', 0.05,
    'most_popular_option', 0.15,
    'walks_away', 0.05
  ),
  'behavior_patterns', jsonb_build_object(
    'impulse_grab', 0.80,
    'reads_fine_print', 0.05,
    'asks_for_help', 0.10,
    'compares_options', 0.10
  ),
  'exploitable_tendencies', jsonb_build_array(
    'skips fine print and price checks',
    'always picks bigger or louder',
    'checks phone mid-decision',
    'skips instructions completely'
  ),
  'context_modifiers', jsonb_build_object(
    'high_stimulus_many_choices', jsonb_build_object('impulse_grab', 0.90, 'flashiest_option', 0.85),
    'casual_quick_choice_moment', jsonb_build_object('impulse_grab', 0.85, 'flashiest_option', 0.70),
    'under_time_pressure', jsonb_build_object('impulse_grab', 0.95, 'compares_options', 0.03)
  )
) WHERE slug = 'mike';

UPDATE characters SET betting_signals = jsonb_build_object(
  'quick_read', jsonb_build_array(
    'Reads every detail carefully (90%)',
    'Picks the careful quality-first choice (80%)',
    'Walks away without choosing (35%)'
  ),
  'choice_patterns', jsonb_build_object(
    'quality_first_option', 0.80,
    'natural_premium_option', 0.75,
    'cheapest_option', 0.05,
    'walks_away_undecided', 0.35
  ),
  'behavior_patterns', jsonb_build_object(
    'reads_details_carefully', 0.90,
    'compares_options', 0.85,
    'impulse_grab', 0.02,
    'asks_stranger_opinion', 0.40
  ),
  'exploitable_tendencies', jsonb_build_array(
    'paralyzed by too many options',
    'always pays up for the upgraded careful pick',
    'puts choices back if unsure',
    'documents to research later instead of choosing now'
  ),
  'context_modifiers', jsonb_build_object(
    'many_parallel_options', jsonb_build_object('reads_details_carefully', 0.95, 'quality_first_option', 0.85),
    'seated_social_choice', jsonb_build_object('walks_away_undecided', 0.20, 'quality_first_option', 0.75),
    'under_time_pressure', jsonb_build_object('walks_away_undecided', 0.55, 'impulse_grab', 0.08)
  )
) WHERE slug = 'elena';

UPDATE characters SET betting_signals = jsonb_build_object(
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
) WHERE slug = 'darius';

UPDATE characters SET betting_signals = jsonb_build_object(
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
) WHERE slug = 'yuki';

UPDATE characters SET betting_signals = jsonb_build_object(
  'quick_read', jsonb_build_array(
    'Picks what he knows (85%)',
    'Complains about cost (70%)',
    'Suspicious of anything new (75%)'
  ),
  'choice_patterns', jsonb_build_object(
    'familiar_option', 0.85,
    'new_or_trendy', 0.05,
    'cheapest_option', 0.40,
    'asks_for_guidance', 0.50
  ),
  'behavior_patterns', jsonb_build_object(
    'checks_dates_and_details', 0.80,
    'grumbles_about_cost', 0.70,
    'sticks_to_habitual_brand', 0.85,
    'thrown_by_unfamiliar_format', 0.65
  ),
  'exploitable_tendencies', jsonb_build_array(
    'will never try anything trendy',
    'always picks the brand he has used for years',
    'complains but still follows through',
    'writes it down and follows the list',
    'suspicious of unfamiliar self-serve flows'
  ),
  'context_modifiers', jsonb_build_object(
    'familiar_setting', jsonb_build_object('familiar_option', 0.90, 'grumbles_about_cost', 0.60),
    'unfamiliar_setting', jsonb_build_object('asks_for_guidance', 0.75, 'thrown_by_unfamiliar_format', 0.80),
    'new_interface_or_format', jsonb_build_object('thrown_by_unfamiliar_format', 0.90, 'asks_for_guidance', 0.80)
  )
) WHERE slug = 'frank';

UPDATE characters SET betting_signals = jsonb_build_object(
  'quick_read', jsonb_build_array(
    'Picks the most practical option (80%)',
    'Sticks to her plan (75%)',
    'Checks the numbers that matter (65%)'
  ),
  'choice_patterns', jsonb_build_object(
    'most_practical', 0.80,
    'optimizes_on_key_metrics', 0.70,
    'impulse_treat', 0.20,
    'bulk_if_sensible', 0.55
  ),
  'behavior_patterns', jsonb_build_object(
    'sticks_to_the_plan', 0.75,
    'compares_value_carefully', 0.70,
    'helps_others_unprompted', 0.45,
    'multi_tasks', 0.80
  ),
  'exploitable_tendencies', jsonb_build_array(
    'always picks practical over pretty',
    'weighs measurable specs before choosing',
    'occasionally adds exactly one treat',
    'organized to a fault',
    'competitive — picks efficient path'
  ),
  'context_modifiers', jsonb_build_object(
    'executing_a_plan', jsonb_build_object('sticks_to_the_plan', 0.85, 'most_practical', 0.85),
    'under_time_pressure', jsonb_build_object('multi_tasks', 0.90, 'sticks_to_the_plan', 0.80),
    'with_friends', jsonb_build_object('helps_others_unprompted', 0.60, 'impulse_treat', 0.35)
  )
) WHERE slug = 'priya';

UPDATE characters SET betting_signals = jsonb_build_object(
  'quick_read', jsonb_build_array(
    'Picks the most beautiful option (75%)',
    'Chooses for others more than self (60%)',
    'Seduced by great presentation (70%)'
  ),
  'choice_patterns', jsonb_build_object(
    'most_beautiful', 0.75,
    'most_unique', 0.65,
    'gift_for_someone', 0.60,
    'practical_option', 0.10
  ),
  'behavior_patterns', jsonb_build_object(
    'seeks_personal_connection', 0.70,
    'takes_scenic_or_slower_path', 0.65,
    'sentimental_gesture_impulse', 0.50,
    'considerate_to_strangers', 0.80
  ),
  'exploitable_tendencies', jsonb_build_array(
    'never picks the practical option',
    'easily seduced by stories and presentation',
    'will make a small sentimental gesture impulsively',
    'always engages whoever is hosting the moment',
    'picks experiences over objects'
  ),
  'context_modifiers', jsonb_build_object(
    'lively_face_to_face_setting', jsonb_build_object('seeks_personal_connection', 0.85, 'most_beautiful', 0.80),
    'with_someone', jsonb_build_object('gift_for_someone', 0.75, 'sentimental_gesture_impulse', 0.65),
    'alone', jsonb_build_object('takes_scenic_or_slower_path', 0.75, 'most_unique', 0.70)
  )
) WHERE slug = 'carlos';

UPDATE characters SET betting_signals = jsonb_build_object(
  'quick_read', jsonb_build_array(
    'Picks the most photogenic option (80%)',
    'Records the moment (75%)',
    'Reverses course later (40%)'
  ),
  'choice_patterns', jsonb_build_object(
    'most_photogenic', 0.80,
    'trending_option', 0.75,
    'practical_option', 0.05,
    'reverses_later', 0.40
  ),
  'behavior_patterns', jsonb_build_object(
    'records_while_deciding', 0.75,
    'self_narrates_the_choice', 0.60,
    'picks_for_visual_impact', 0.80,
    'swayed_by_online_trends', 0.70
  ),
  'exploitable_tendencies', jsonb_build_array(
    'optimizes every decision for how it will look',
    'picks whatever is trending this week',
    'has main character energy always',
    'often changes her mind after the fact',
    'will try anything if it gets attention'
  ),
  'context_modifiers', jsonb_build_object(
    'might_share_publicly', jsonb_build_object('most_photogenic', 0.85, 'records_while_deciding', 0.80),
    'visible_to_others', jsonb_build_object('records_while_deciding', 0.85, 'self_narrates_the_choice', 0.70),
    'private_or_offline', jsonb_build_object('most_photogenic', 0.50, 'records_while_deciding', 0.30)
  )
) WHERE slug = 'zara';

-- Newer seeded characters
UPDATE characters SET betting_signals = jsonb_build_object(
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
) WHERE slug = 'nina';

UPDATE characters SET betting_signals = jsonb_build_object(
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
) WHERE slug = 'baxter';

UPDATE characters SET betting_signals = jsonb_build_object(
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
) WHERE slug = 'lila';

UPDATE characters SET betting_signals = jsonb_build_object(
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
) WHERE slug = 'earl';

UPDATE characters SET betting_signals = jsonb_build_object(
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
) WHERE slug = 'viktor';

UPDATE characters SET betting_signals = jsonb_build_object(
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
) WHERE slug = 'malik';
