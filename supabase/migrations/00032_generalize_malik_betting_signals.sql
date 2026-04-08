-- Scene-agnostic betting_signals + preference blurbs for Malik (pool, street, etc.).
-- Original seed used kitchen-specific labels; UI shows these keys as human text.

UPDATE characters
SET
  preferences = jsonb_set(
    jsonb_set(
      preferences,
      '{shopping}',
      to_jsonb(
        'checks quality, consistency, and value before choosing — same habit in any setting'::text
      )
    ),
    '{general_tendencies}',
    jsonb_build_array(
      'chooses reliable options over trendy ones',
      'keeps his space and process tidy while doing something',
      'verifies the important detail before moving on',
      'prefers repeatable methods over flashy improvisation',
      'finishes one step cleanly before starting the next'
    )
  ),
  betting_signals = jsonb_build_object(
    'quick_read',
    jsonb_build_array(
      'Chooses consistency over speed (82%)',
      'Keeps his process organized (86%)',
      'Avoids flashy risky moves (78%)'
    ),
    'choice_patterns',
    jsonb_build_object(
      'reliable_trusted_option',
      0.81,
      'value_plus_quality_option',
      0.77,
      'flashy_trend_option',
      0.09,
      'refine_before_committing',
      0.58
    ),
    'behavior_patterns',
    jsonb_build_object(
      'verifies_before_next_step',
      0.84,
      'stays_tidy_while_working',
      0.79,
      'slows_down_under_pressure',
      0.74,
      'asks_for_external_help',
      0.24
    ),
    'exploitable_tendencies',
    jsonb_build_array(
      'will sacrifice speed for consistent output',
      'rarely chooses high-variance shortcuts',
      'prefers controlled sequences over improvisation',
      'defaults to quality plus value, not hype'
    ),
    'context_modifiers',
    jsonb_build_object(
      'familiar_setting',
      jsonb_build_object(
        'reliable_trusted_option',
        0.86,
        'verifies_before_next_step',
        0.88
      ),
      'time_pressure',
      jsonb_build_object(
        'slows_down_under_pressure',
        0.79,
        'flashy_trend_option',
        0.05
      ),
      'with_others_nearby',
      jsonb_build_object(
        'asks_for_external_help',
        0.30,
        'stays_tidy_while_working',
        0.75
      )
    )
  )
WHERE slug = 'malik';
