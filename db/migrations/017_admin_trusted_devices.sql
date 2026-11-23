-- Admin login: trusted devices, remember me, login alerts (client approved, 23 Nov 2026).
-- All DATETIMEs are UTC. Only SHA-256 hashes of device tokens and refresh tokens are stored.

-- A browser the admin chose to trust after a correct emailed code. Login from it with the right password needs no
-- code (no expiry). Revoked by the admin, a Full Admin, a password change/reset, deactivation, a role change, or when
-- an 11th device is trusted (the oldest is revoked; at most 10 live ones per admin).
CREATE TABLE IF NOT EXISTS admin_trusted_devices (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  admin_id      BIGINT UNSIGNED NOT NULL,
  token_hash    CHAR(64) NOT NULL,
  label         VARCHAR(100) NOT NULL DEFAULT 'Unknown device',   -- from the user agent, e.g. "Chrome on Windows"
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at  DATETIME NULL,
  revoked_at    DATETIME NULL,
  UNIQUE KEY uq_admin_trusted_devices_token (token_hash),
  KEY idx_admin_trusted_devices_admin (admin_id, revoked_at),
  CONSTRAINT fk_admin_trusted_devices_admin FOREIGN KEY (admin_id) REFERENCES admins (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- "Remember me" sessions: a refresh token valid 30 days, rolling (each refresh rotates it and restarts the 30 days).
-- token_version = admins.token_version when issued; any later bump (logout, password change, role change,
-- deactivation) makes the row unusable.
CREATE TABLE IF NOT EXISTS admin_refresh_tokens (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  admin_id       BIGINT UNSIGNED NOT NULL,
  token_hash     CHAR(64) NOT NULL,
  token_version  INT UNSIGNED NOT NULL,
  expires_at     DATETIME NOT NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at   DATETIME NULL,
  revoked_at     DATETIME NULL,
  UNIQUE KEY uq_admin_refresh_tokens_token (token_hash),
  KEY idx_admin_refresh_tokens_admin (admin_id, revoked_at),
  CONSTRAINT fk_admin_refresh_tokens_admin FOREIGN KEY (admin_id) REFERENCES admins (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Login alert emails to Full Admins: at most one per signed-in admin per 10 minutes.
ALTER TABLE admins ADD COLUMN last_login_alert_at DATETIME NULL AFTER last_login_at;
