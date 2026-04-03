-- Four additional image patterns (seed assets: supabase/seed-assets/patterns/*.png → upload to media bucket as patterns/<name>.png)

INSERT INTO image_patterns (slug, title, description, image_storage_path, base_scene, sort_order)
VALUES
  (
    'woman_sleeping_mask',
    'Sleeping in Bed',
    'Young woman asleep in bed wearing a light blue satin sleep mask and pajamas, moody bedroom light',
    'patterns/woman_sleeping_mask.png',
    jsonb_build_object(
      'subject', 'young woman lying on her back on white pillows, light blue satin sleep mask covering eyes, matching light blue satin pajamas with delicate white lace trim at collar and sleeves, brown hair spread on pillow, calm neutral expression',
      'subject_state', 'asleep, right arm bent with hand open near top of head on pillow, left arm resting across stomach with hand on white sheet, two thin silver rings visible on left hand',
      'environment', 'bed with white pillows with subtle vertical stripes, white sheet pulled to waist, dark grey quilted blanket with geometric pattern visible at lower edge, cool blue and white palette, cinematic low-key lighting with soft light on left side of face and deep shadow on right, quiet nighttime mood',
      'camera', 'high angle close-up, medium close-up on face and upper body, slightly off-center, shallow depth of field, 9:16 vertical',
      'textures', 'satin sheen on mask and pajamas, delicate lace, crisp white bedding, cool skin tones, directional soft light and shadow contrast'
    ),
    9
  ),
  (
    'friends_urban_group',
    'Friends Group Photo',
    'Four diverse friends standing together outdoors in front of modern concrete architecture, posing for a photo',
    'patterns/friends_urban_group.png',
    jsonb_build_object(
      'subject', 'four adults in a line: man left in tan beanie, glasses, mustard puffer jacket, brown trousers, hand on next shoulder; Black woman with long dark braids, peach quilted jacket, white pants, boots; man center-right in rust hoodie, dark overcoat, maroon trousers, arm around woman beside him; woman right with light brown dreadlocks, olive parka over grey sweatshirt, blue jeans, combat boots; all smiling at camera',
      'subject_state', 'standing close together in posed group photo, relaxed friendly posture, full body visible',
      'environment', 'outdoor urban plaza, light grey rectangular paving stones, large angled dark grey concrete wall behind with grid of small square recessed openings, gravel slope to the left of structure, bright diffused overcast daylight, soft shadows',
      'camera', 'front-facing medium full shot, eye level, all four subjects centered, 35mm lens feel, 9:16 vertical',
      'textures', 'knit beanie, quilted and puffer fabrics, leather shoes and boots, concrete grid pattern, muted natural colors'
    ),
    10
  ),
  (
    'friends_selfie_pond',
    'Selfie by the Water',
    'Two young women on a stone ledge by a calm pond in a sunlit park, framing a selfie',
    'patterns/friends_selfie_pond.png',
    jsonb_build_object(
      'subject', 'two young Asian women sitting side by side on a grey concrete ledge: woman in front with short brown hair, glasses, white long-sleeved blouse, blue denim skirt; woman behind with longer brown hair, white t-shirt, light denim skirt; both smiling brightly toward camera off to the side',
      'subject_state', 'foreground woman extends right arm toward camera with peace sign, woman behind holds phone outstretched to frame selfie, leaning in close, casual relaxed pose on ledge',
      'environment', 'urban park, calm pond or fountain in background reflecting trees and distant buildings, sun-drenched, tall trees casting soft shadows, bright pleasant daylight',
      'camera', 'slightly low angle medium shot, both subjects waist-up, shallow depth of field on background water, 9:16 vertical',
      'textures', 'denim fabric, white cotton blouse, ripples on water surface, warm sunlight, natural skin tones'
    ),
    16
  ),
  (
    'man_cooking_kitchen',
    'Cooking at the Stove',
    'Young man in profile at a home stove, focused on a frying pan in a bright rustic kitchen',
    'patterns/man_cooking_kitchen.png',
    jsonb_build_object(
      'subject', 'young man with short dark hair shaved on the sides, in profile, blue and white plaid flannel shirt, silver ring on left hand, left hand reaching toward frying pan on stove, right hand raised near face holding a small hand-rolled cigarette',
      'subject_state', 'leaning slightly over stove, eyes down at pan, attentive cooking posture',
      'environment', 'rustic home kitchen, white tiled walls, light wooden upper cabinets, magnetic knife strip with yellow-handled knives, circular decorative wall relief in background, soft natural side lighting',
      'camera', 'side profile medium shot, waist-up, subject left of frame looking down at stove, 50mm lens feel, 9:16 vertical',
      'textures', 'plaid cotton shirt, stainless pan, steam possible from food, matte tile, warm neutral tones'
    ),
    12
  )
ON CONFLICT (slug) DO UPDATE
SET
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  base_scene = EXCLUDED.base_scene,
  sort_order = EXCLUDED.sort_order,
  active = true;
