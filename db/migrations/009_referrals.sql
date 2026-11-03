-- Referrals (contract 8.3 + client rules, 30 Oct 2026). The referral code belongs to the account (not a profile).
-- Codes are 6 characters from an alphabet without 0 / O / 1 / I (easy to read and type). Accounts get one when their
-- email is verified, or the first time they open GET /me/referral (accounts created before this migration).
ALTER TABLE accounts
  ADD COLUMN referral_code VARCHAR(12) NULL AFTER gender,
  ADD UNIQUE KEY uq_accounts_referral_code (referral_code);

-- One row per new account that applied a friend's code (UNIQUE referee: one code per account).
--   New user: +new_user_sparks reserved at once (new_user_status 'reserved' → 'credited' by the M2 Sparks ledger).
--   Referrer: +referrer_sparks only after the new user completes their first full quiz:
--     status 'waiting_for_first_quiz' → 'qualified' (onFirstQuizCompleted, Milestone 3) → 'credited' (Milestone 2 ledger),
--     or 'rejected' (e.g. abuse found later). The amounts are copied from app_settings when the code is applied.
-- device_hash: an HMAC of the app's random install id (no hardware id, nothing personal), only used to refuse a second
-- referral from the same phone. Deleting the new user's account deletes the row; deleting the referrer keeps the new
-- user's reward (referrer_account_id becomes NULL).
CREATE TABLE IF NOT EXISTS referrals (
  id                   BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  referrer_account_id  BIGINT UNSIGNED NULL,
  referee_account_id   BIGINT UNSIGNED NOT NULL,
  code                 VARCHAR(12) NOT NULL,
  status               ENUM('waiting_for_first_quiz','qualified','credited','rejected') NOT NULL DEFAULT 'waiting_for_first_quiz',
  new_user_sparks      INT NOT NULL,
  new_user_status      ENUM('reserved','credited') NOT NULL DEFAULT 'reserved',
  referrer_sparks      INT NOT NULL,
  device_hash          CHAR(64) NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  qualified_at         DATETIME NULL,
  credited_at          DATETIME NULL,
  UNIQUE KEY uq_referrals_referee (referee_account_id),
  KEY idx_referrals_referrer (referrer_account_id, status),
  KEY idx_referrals_device (device_hash),
  CONSTRAINT fk_referrals_referee FOREIGN KEY (referee_account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  CONSTRAINT fk_referrals_referrer FOREIGN KEY (referrer_account_id) REFERENCES accounts(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Settings a Full Admin can change in the Admin Panel (audited). Values are stored as text; NULL = not limited.
CREATE TABLE IF NOT EXISTS app_settings (
  setting_key  VARCHAR(64) NOT NULL PRIMARY KEY,
  value        VARCHAR(255) NULL,
  updated_by   BIGINT UNSIGNED NULL,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO app_settings (setting_key, value) VALUES
  ('referral_new_user_sparks', '25'),
  ('referral_referrer_sparks', '50'),
  ('referral_window_hours', '48'),
  ('referral_max_per_referrer', NULL);
