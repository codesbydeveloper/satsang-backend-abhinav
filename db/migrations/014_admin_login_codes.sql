-- Admin login: email one-time code replaces the authenticator app (client approved, 20 Nov 2026).
-- One row per login attempt that passed the password check. Only a SHA-256 hash of the 6-digit code is stored.
-- A resend replaces code_hash (the old code stops working), resets attempts and counts in resend_count.
-- All DATETIMEs are UTC. admins.totp_secret_enc / admins.totp_enabled are kept (no data loss) but no longer used.

CREATE TABLE IF NOT EXISTS admin_login_codes (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  admin_id      BIGINT UNSIGNED NOT NULL,
  code_hash     CHAR(64) NOT NULL,
  expires_at    DATETIME NOT NULL,
  attempts      TINYINT UNSIGNED NOT NULL DEFAULT 0,
  resend_count  TINYINT UNSIGNED NOT NULL DEFAULT 0,
  last_sent_at  DATETIME NOT NULL,
  used_at       DATETIME NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_admin_login_codes_admin (admin_id, created_at),
  CONSTRAINT fk_admin_login_codes_admin FOREIGN KEY (admin_id) REFERENCES admins (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
