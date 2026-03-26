-- Image patterns: pre-made starting images users can pick for quick video generation

CREATE TABLE IF NOT EXISTS image_patterns (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  image_storage_path TEXT NOT NULL,
  base_scene JSONB NOT NULL DEFAULT '{}'::jsonb,
  active BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Add generation_mode to clip_generation_jobs so we can distinguish the 3 modes
ALTER TABLE clip_generation_jobs
  ADD COLUMN IF NOT EXISTS generation_mode TEXT NOT NULL DEFAULT 'ai_full';

-- Seed the 4 initial patterns (image_storage_path filled after upload)
INSERT INTO image_patterns (slug, title, description, image_storage_path, base_scene, sort_order)
VALUES
  (
    'lion_grass',
    'Lion on Grass',
    'Majestic male lion lying on green grass, profile view',
    'patterns/lion_grass.png',
    jsonb_build_object(
      'subject', 'adult male lion with thick golden mane, lying on green grass, profile view facing left',
      'subject_state', 'calm, slow breathing, eyes half-open, resting front paws crossed',
      'environment', 'African grassland, soft afternoon sunlight, shallow depth of field, blurred green background',
      'camera', 'close-up profile, eye-level, shallow DOF, 85mm lens, 9:16 vertical',
      'textures', 'golden mane gently shifting in breeze, individual grass blades visible'
    ),
    1
  ),
  (
    'vending_machine',
    'Vending Machine',
    'Red Coca-Cola vending machine on urban sidewalk',
    'patterns/vending_machine.png',
    jsonb_build_object(
      'subject', 'red Coca-Cola vending machine, front-facing, 8 drink slots visible, coin slot on right',
      'subject_state', 'standing still, lights on, drinks visible behind glass panels, no people nearby',
      'environment', 'urban sidewalk, chain-link fence behind, concrete ground, daylight, slight shadows',
      'camera', 'straight-on front view, medium shot, full machine visible, 35mm lens, 9:16 vertical',
      'textures', 'glossy red metal surface, condensation on glass panels, scuffed concrete'
    ),
    2
  ),
  (
    'beetle_red_light',
    'VW Beetle at Red Light',
    'Yellow vintage Beetle stopped at red traffic light in European city',
    'patterns/beetle_red_light.png',
    jsonb_build_object(
      'subject', 'yellow vintage VW Beetle, rear view, stopped at intersection, brake lights faintly visible',
      'subject_state', 'engine idling, stationary, slight exhaust haze, waiting at red light',
      'environment', 'European city intersection, ornate buildings, red traffic light overhead, sunny day, blue sky with clouds, pedestrians and cyclists in background',
      'camera', 'rear view slightly above, medium shot, car centered in lane, 50mm lens, 9:16 vertical',
      'textures', 'warm yellow paint with minor wear, cobblestone-adjacent road markings, golden building facades'
    ),
    3
  ),
  (
    'woman_two_outfits',
    'Choosing Between Outfits',
    'Woman holding two dresses, trying to decide which to wear',
    'patterns/woman_two_outfits.png',
    jsonb_build_object(
      'subject', 'young woman with natural afro hair, holding two dresses on hangers, one black lace on left hand, one floral colorful on right hand',
      'subject_state', 'standing against plain wall, neutral expression, arms raised showing both options, wearing cream blouse',
      'environment', 'simple room, soft diffused light from left, plain light grey wall, minimal setting',
      'camera', 'front-facing, medium shot, waist-up, centered, 50mm lens, 9:16 vertical',
      'textures', 'natural curly hair texture, delicate lace on black dress, floral print detail on colorful dress'
    ),
    4
  )
  ,
  (
    'solo_shopper_aisle',
    'Solo Shopper in Aisle',
    'Person walking alone through supermarket aisle with basket, seen from behind',
    'patterns/solo_shopper_aisle.png',
    jsonb_build_object(
      'subject', 'person in black jacket and white beanie, back to camera, pulling small shopping basket on wheels, walking down center of aisle',
      'subject_state', 'walking slowly forward, head slightly tilted, browsing shelves on both sides, casual pace',
      'environment', 'narrow supermarket aisle, pasta and oils section, warm overhead fluorescent lighting, products stacked high on both sides, tiled floor',
      'camera', 'behind subject, low angle following, centered in aisle, 35mm lens, 9:16 vertical',
      'textures', 'fabric of black jacket, knit beanie texture, colorful product packaging on shelves, glossy floor tiles'
    ),
    5
  ),
  (
    'couple_grocery',
    'Couple Grocery Shopping',
    'Couple examining bread at bakery section with full shopping cart',
    'patterns/couple_grocery.png',
    jsonb_build_object(
      'subject', 'woman in hijab and denim jacket holding bread loaf in left hand and phone in right, man in blue beanie and grey jacket leaning on cart handle, both facing bakery display',
      'subject_state', 'woman inspecting bread closely, man watching her, cart full of oranges and groceries, both standing still',
      'environment', 'supermarket bakery section, warm display lights, shelves of baked goods behind glass, modern store interior',
      'camera', 'front-facing slightly right, medium shot, both subjects waist-up, 50mm lens, 9:16 vertical',
      'textures', 'woven hijab fabric, denim jacket texture, glossy bread packaging, bright orange fruits in cart'
    ),
    6
  ),
  (
    'golf_putt',
    'Golf Putt Setup',
    'Golfer lined up for a putt, close-up on club and ball on green',
    'patterns/golf_putt.png',
    jsonb_build_object(
      'subject', 'golfer in red polo shirt and khaki shorts, standing over golf ball with blue-shafted putter, ball on tee, only lower body and hands visible',
      'subject_state', 'address position, knees slightly bent, putter head resting behind ball, weight balanced, completely still, about to swing',
      'environment', 'bright green putting green, sunny day, two people standing far in background, open golf course landscape',
      'camera', 'low angle, ground-level, close-up on feet and club, shallow DOF, 85mm lens, 9:16 vertical',
      'textures', 'manicured grass blades, white dimpled golf ball, Nike shoes with yellow soles, worn leather grip on putter'
    ),
    7
  ),
  (
    'roller_skater',
    'Roller Skater on Road',
    'Woman roller skating down a tree-lined street, smiling',
    'patterns/roller_skater.png',
    jsonb_build_object(
      'subject', 'woman with blonde hair and red headband, wearing black polka-dot top, black jeans with knee pads, white roller skates with red wheels, arms relaxed at sides',
      'subject_state', 'gliding forward on smooth road, smiling, balanced stance, slight forward lean, relaxed and confident',
      'environment', 'wide tree-lined residential street, large sycamore trees forming canopy, dappled sunlight, parked cars in far background, asphalt road',
      'camera', 'front-facing, full body, medium shot, centered on road, 50mm lens, 9:16 vertical',
      'textures', 'polka-dot fabric, worn knee pads, smooth white leather skate boots, cracked asphalt surface, tree bark'
    ),
    8
  )
ON CONFLICT (slug) DO UPDATE
SET
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  base_scene = EXCLUDED.base_scene,
  sort_order = EXCLUDED.sort_order,
  active = true;
