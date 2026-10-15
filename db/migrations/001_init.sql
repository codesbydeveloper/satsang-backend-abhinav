-- Satsang Spark V1 — Milestone 1 schema (MySQL 8 / MariaDB 10.6+)
-- Accounts (adult/parent), playable profiles, avatars, auth tokens, admin users, audit log.

CREATE TABLE IF NOT EXISTS avatars (
  id          TINYINT UNSIGNED PRIMARY KEY,
  avatar_key  VARCHAR(40)  NOT NULL UNIQUE,
  kind        ENUM('animal','human') NOT NULL,
  label       VARCHAR(60)  NOT NULL,
  asset_url   VARCHAR(255) NULL,          -- filled once Om's final artwork is uploaded
  is_active   TINYINT(1)   NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO avatars (id, avatar_key, kind, label) VALUES
  (1,'animal_01','animal','Animal 1'),(2,'animal_02','animal','Animal 2'),
  (3,'animal_03','animal','Animal 3'),(4,'animal_04','animal','Animal 4'),
  (5,'animal_05','animal','Animal 5'),(6,'animal_06','animal','Animal 6'),
  (7,'animal_07','animal','Animal 7'),(8,'animal_08','animal','Animal 8'),
  (9,'animal_09','animal','Animal 9'),(10,'animal_10','animal','Animal 10'),
  (11,'human_01','human','Human 1'),(12,'human_02','human','Human 2'),
  (13,'human_03','human','Human 3'),(14,'human_04','human','Human 4'),
  (15,'human_05','human','Human 5'),(16,'human_06','human','Human 6');

CREATE TABLE IF NOT EXISTS accounts (
  id                     BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email                  VARCHAR(254) NOT NULL,
  password_hash          VARCHAR(100) NOT NULL,
  account_type           ENUM('adult','parent') NOT NULL,
  phone                  VARCHAR(32)  NULL,              -- optional contact only, never used for login
  preferred_language     ENUM('en','gu') NOT NULL DEFAULT 'en',
  email_verified_at      DATETIME NULL,
  token_version          INT UNSIGNED NOT NULL DEFAULT 0, -- bump to invalidate every issued token
  parent_pin_hash        VARCHAR(100) NULL,
  pin_failed_attempts    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  pin_locked_until       DATETIME NULL,
  privacy_policy_version VARCHAR(20) NULL,
  consent_accepted_at    DATETIME NULL,
  created_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_accounts_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS profiles (
  id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  account_id          BIGINT UNSIGNED NOT NULL,
  username            VARCHAR(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,   -- as typed (shown publicly)
  username_lower      VARCHAR(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,   -- case-insensitive uniqueness
  avatar_id           TINYINT UNSIGNED NOT NULL,
  dob                 DATE NOT NULL,                                                      -- private, never exposed publicly
  age_group           VARCHAR(32) NOT NULL,
  is_child            TINYINT(1) NOT NULL DEFAULT 0,
  language            ENUM('en','gu') NOT NULL DEFAULT 'en',
  mode                ENUM('sanatan','satsang') NULL,
  age_group_override  VARCHAR(32) NULL,                                                   -- set by an admin; wins over DOB
  consent_version     VARCHAR(20) NULL,
  consent_at          DATETIME NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_profiles_username (username_lower),
  KEY ix_profiles_account (account_id),
  KEY ix_profiles_age_group (age_group),
  CONSTRAINT fk_profiles_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  CONSTRAINT fk_profiles_avatar  FOREIGN KEY (avatar_id)  REFERENCES avatars(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS email_codes (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  account_id  BIGINT UNSIGNED NOT NULL,
  purpose     ENUM('verify_email','reset_password') NOT NULL,
  code_hash   CHAR(64) NOT NULL,
  attempts    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  expires_at  DATETIME NOT NULL,
  consumed_at DATETIME NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_codes_lookup (account_id, purpose),
  CONSTRAINT fk_codes_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One row per refresh token. session_id stays the same across rotations so a device session can
-- remember which playable profile is active (profile_id NULL = parent mode / no profile).
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  account_id  BIGINT UNSIGNED NOT NULL,
  session_id  CHAR(32) NOT NULL,
  profile_id  BIGINT UNSIGNED NULL,
  token_hash  CHAR(64) NOT NULL,
  expires_at  DATETIME NOT NULL,
  revoked_at  DATETIME NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_refresh_hash (token_hash),
  KEY ix_refresh_account (account_id),
  KEY ix_refresh_session (session_id),
  CONSTRAINT fk_refresh_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Admin-managed username moderation list (English + Gujarati script + transliterations).
CREATE TABLE IF NOT EXISTS blocked_words (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  word       VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  kind       ENUM('blocked','reserved') NOT NULL DEFAULT 'blocked',
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_blocked_word (word)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO blocked_words (word, kind) VALUES
  ('fuck','blocked'),('shit','blocked'),('bitch','blocked'),('asshole','blocked'),
  ('porn','blocked'),('nude','blocked'),('sex','blocked'),
  ('admin','reserved'),('administrator','reserved'),('moderator','reserved'),
  ('support','reserved'),('loyadham','reserved'),('satsangspark','reserved'),('official','reserved');

CREATE TABLE IF NOT EXISTS admins (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email            VARCHAR(254) NOT NULL,
  name             VARCHAR(100) NOT NULL DEFAULT '',
  password_hash    VARCHAR(100) NOT NULL,
  role             ENUM('full_admin','content_editor') NOT NULL,
  totp_secret_enc  VARCHAR(255) NULL,
  totp_enabled     TINYINT(1) NOT NULL DEFAULT 0,
  is_active        TINYINT(1) NOT NULL DEFAULT 1,
  token_version    INT UNSIGNED NOT NULL DEFAULT 0,
  failed_attempts  TINYINT UNSIGNED NOT NULL DEFAULT 0,
  locked_until     DATETIME NULL,
  last_login_at    DATETIME NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_admins_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_log (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  admin_id     BIGINT UNSIGNED NULL,
  admin_email  VARCHAR(254) NULL,
  action       VARCHAR(60) NOT NULL,
  entity_type  VARCHAR(40) NULL,
  entity_id    VARCHAR(40) NULL,
  details      JSON NULL,
  ip           VARCHAR(64) NULL,
  user_agent   VARCHAR(255) NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_audit_created (created_at),
  KEY ix_audit_admin (admin_id),
  KEY ix_audit_entity (entity_type, entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
