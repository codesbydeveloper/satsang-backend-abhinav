-- The 16 client avatars (client change, 3 Nov 2026): named, ids 1–10 animal, 11–16 human (contract: 10 animal, 6 human).
-- Ids are unchanged, so every profile keeps its avatar. The app shows the names in English and Gujarati from its own
-- texts (key avatar.<id>); `label` here is the English name for the Admin Panel and /api-docs.
UPDATE avatars SET avatar_key = CONCAT('tmp_', id) WHERE id BETWEEN 1 AND 16;   -- avatar_key is UNIQUE: free the keys first
UPDATE avatars SET is_active = 1, kind = CASE WHEN id <= 10 THEN 'animal' ELSE 'human' END,
  avatar_key = CASE id
    WHEN 1 THEN 'shadow'   WHEN 2 THEN 'frosty'      WHEN 3 THEN 'waddles'   WHEN 4 THEN 'turbo'
    WHEN 5 THEN 'blaze'    WHEN 6 THEN 'zippy'       WHEN 7 THEN 'bamboo'    WHEN 8 THEN 'ace'
    WHEN 9 THEN 'mango'    WHEN 10 THEN 'coco'       WHEN 11 THEN 'young_boy' WHEN 12 THEN 'young_man'
    WHEN 13 THEN 'gentleman' WHEN 14 THEN 'young_girl' WHEN 15 THEN 'young_woman' WHEN 16 THEN 'lady' END,
  label = CASE id
    WHEN 1 THEN 'Shadow'   WHEN 2 THEN 'Frosty'      WHEN 3 THEN 'Waddles'   WHEN 4 THEN 'Turbo'
    WHEN 5 THEN 'Blaze'    WHEN 6 THEN 'Zippy'       WHEN 7 THEN 'Bamboo'    WHEN 8 THEN 'Ace'
    WHEN 9 THEN 'Mango'    WHEN 10 THEN 'Coco'       WHEN 11 THEN 'Young Boy' WHEN 12 THEN 'Young Man'
    WHEN 13 THEN 'Gentleman' WHEN 14 THEN 'Young Girl' WHEN 15 THEN 'Young Woman' WHEN 16 THEN 'Lady' END
WHERE id BETWEEN 1 AND 16;
