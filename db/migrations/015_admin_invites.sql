-- Add admins by email invite (client approved, 20 Nov 2026). An invited admin has no password yet and is not active
-- (is_active = 0, password_hash NULL) until they open the emailed link and choose a password.
-- Only a SHA-256 hash of the invite token is stored; a resend replaces it (the old link stops working).
-- All DATETIMEs are UTC. Existing admins (with a password) are unaffected.

ALTER TABLE admins
  MODIFY password_hash VARCHAR(100) NULL,
  ADD COLUMN invite_token_hash CHAR(64) NULL AFTER password_hash,
  ADD COLUMN invite_expires_at DATETIME NULL AFTER invite_token_hash,
  ADD COLUMN invited_by        BIGINT UNSIGNED NULL AFTER invite_expires_at,   -- admins.id of the Full Admin who invited
  ADD COLUMN invited_at        DATETIME NULL AFTER invited_by,
  ADD COLUMN activated_at      DATETIME NULL AFTER invited_at,                 -- when the invite was accepted
  ADD UNIQUE KEY uq_admins_invite_token (invite_token_hash);
