-- Two languages (client change, 3 Nov 2026):
--   App language   = menus, buttons, settings, account setup: accounts.preferred_language / profiles.language (unchanged).
--   Content language = questions, games, PDFs, learning content: profiles.content_language, per playable profile.
-- New profiles get the content language sent by the app, else the app language. Existing profiles start with their
-- app language, so nothing changes for them.
ALTER TABLE profiles
  ADD COLUMN content_language ENUM('en','gu') NULL AFTER language;

UPDATE profiles SET content_language = language WHERE content_language IS NULL;

ALTER TABLE profiles
  MODIFY content_language ENUM('en','gu') NOT NULL DEFAULT 'en';
