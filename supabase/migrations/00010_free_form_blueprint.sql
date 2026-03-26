INSERT INTO clip_blueprints (slug, label, category, description, config_json)
VALUES
  (
    'free_form',
    'Free form (any concept)',
    'free_form',
    'Any scenario with an uncertain outcome. The AI interprets your prompt and builds tension + two possible outcomes automatically.',
    jsonb_build_object(
      'suggested_outcomes', jsonb_build_array(
        'Outcome A',
        'Outcome B',
        'Something unexpected'
      )
    )
  ),
  (
    'collision_or_miss',
    'Collision or miss',
    'collision_or_miss',
    'Two objects on a collision course; clip cuts before impact.',
    jsonb_build_object(
      'suggested_outcomes', jsonb_build_array(
        'They collide',
        'They narrowly miss',
        'One stops'
      )
    )
  ),
  (
    'chain_reaction',
    'Chain reaction',
    'chain_reaction',
    'A domino / chain reaction in progress; clip cuts before it completes.',
    jsonb_build_object(
      'suggested_outcomes', jsonb_build_array(
        'Chain completes',
        'Chain breaks',
        'Something unexpected interrupts'
      )
    )
  ),
  (
    'countdown_or_timer',
    'Countdown / Timer',
    'countdown_or_timer',
    'Something counts down or builds toward a timed event; clip cuts before zero.',
    jsonb_build_object(
      'suggested_outcomes', jsonb_build_array(
        'Timer reaches zero',
        'Timer stops early',
        'Something happens before zero'
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
