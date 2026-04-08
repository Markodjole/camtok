-- Remove/deactivate characters that have no reference images.
-- Safety rule:
-- 1) If character has no images and is NOT used by any clip -> hard delete.
-- 2) If character has no images but is already used by clips -> keep row, set active=false.

WITH imageless AS (
  SELECT c.id
  FROM characters c
  LEFT JOIN character_reference_images cri ON cri.character_id = c.id
  GROUP BY c.id
  HAVING COUNT(cri.id) = 0
),
unused_imageless AS (
  SELECT i.id
  FROM imageless i
  LEFT JOIN clip_nodes cn ON cn.character_id = i.id
  GROUP BY i.id
  HAVING COUNT(cn.id) = 0
)
DELETE FROM characters
WHERE id IN (SELECT id FROM unused_imageless);

WITH imageless AS (
  SELECT c.id
  FROM characters c
  LEFT JOIN character_reference_images cri ON cri.character_id = c.id
  GROUP BY c.id
  HAVING COUNT(cri.id) = 0
),
used_imageless AS (
  SELECT i.id
  FROM imageless i
  LEFT JOIN clip_nodes cn ON cn.character_id = i.id
  GROUP BY i.id
  HAVING COUNT(cn.id) > 0
)
UPDATE characters
SET active = false
WHERE id IN (SELECT id FROM used_imageless);

