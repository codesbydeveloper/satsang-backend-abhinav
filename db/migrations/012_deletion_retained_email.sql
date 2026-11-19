-- Deleted accounts keep their email for a short time (client approved, 19 Nov 2026), so a Full Admin can answer
-- "was my account deleted?" questions. Only the email is kept, only on the deletion request row, and only until
-- email_retained_until (RETAINED_EMAIL_DAYS, default 30). The purge job (src/utils/retainedEmails.js, run on server
-- start, every 24 hours and by `npm run purge:retained-emails`) sets email_retained back to NULL after that.
ALTER TABLE account_deletion_requests
  ADD COLUMN email_retained       VARCHAR(254) NULL AFTER decision_note,
  ADD COLUMN email_retained_until DATETIME NULL AFTER email_retained,
  ADD KEY ix_deletion_email_retained_until (email_retained_until);
