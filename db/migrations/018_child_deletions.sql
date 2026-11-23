-- Deleting profiles (Part D/E, 23 Nov 2026).
-- * A child profile deleted on its own (parent area in the app, or a Full Admin) is recorded as a completed deletion
--   entry: target = 'child_profile', profile_id = the deleted child, account_id = the parent (who keeps the account).
-- * Every completed entry may keep the username next to the email (username_retained) for the same period
--   (email_retained_until, RETAINED_EMAIL_DAYS, default 30). For a child entry the email is the parent's (children
--   have none). The purge job (src/utils/retainedEmails.js) erases both after that.
-- * source 'admin': deleted by a Full Admin from the Users page (no request from the owner).
ALTER TABLE account_deletion_requests
  MODIFY COLUMN source ENUM('app','web','admin') NOT NULL,
  ADD COLUMN target ENUM('account','child_profile') NOT NULL DEFAULT 'account' AFTER account_type,
  ADD COLUMN profile_id BIGINT UNSIGNED NULL AFTER target,              -- no FK: the profile is gone
  ADD COLUMN username_retained VARCHAR(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL AFTER email_retained;
