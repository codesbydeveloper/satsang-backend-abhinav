-- Home tab (Milestone 2, chunk 2.3A, contract 6.7 + 8.3): Daily Spark Spin, Streak Bonus, News & Updates, Feedback.
-- All DATETIMEs are UTC. Rewards are credited through the Sparks ledger (sparks_transactions, types daily_spin and
-- streak); the tables below only hold the timers, the configuration and the content.

-- Daily Spark Spin wheel. Empty table = the built-in defaults in src/services/dailySpin.js (TO BE CONFIRMED BY
-- LOYADHAM). A Full Admin's save replaces the whole wheel. position = 0-based segment index shown on the wheel.
CREATE TABLE IF NOT EXISTS spin_segments (
  position    TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  label       VARCHAR(40) NULL,
  sparks      INT UNSIGNED NOT NULL,
  weight      INT UNSIGNED NOT NULL,
  updated_by  BIGINT UNSIGNED NULL,
  updated_at  DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One row per successful spin of a playable profile. The next spin is available 24 h after the LATEST row (rolling,
-- not calendar). transaction_id = the ledger row's id (the app's UUID): a retried request returns the same result.
-- Belongs to the profile: deleted with it.
CREATE TABLE IF NOT EXISTS daily_spins (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  profile_id      BIGINT UNSIGNED NOT NULL,
  transaction_id  VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  segment_index   TINYINT UNSIGNED NOT NULL,
  label           VARCHAR(40) NULL,
  sparks          INT UNSIGNED NOT NULL,
  spun_at         DATETIME NOT NULL,
  UNIQUE KEY uq_daily_spins_tx (transaction_id),
  KEY idx_daily_spins_profile (profile_id, spun_at),
  CONSTRAINT fk_daily_spins_profile FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Streak Bonus amounts: Sparks added to the unclaimed bonus on streak day N. Days after the last row use the last
-- row's amount. Empty table = the built-in defaults in src/services/streak.js (TO BE CONFIRMED BY LOYADHAM).
CREATE TABLE IF NOT EXISTS streak_bonus_amounts (
  day         SMALLINT UNSIGNED NOT NULL PRIMARY KEY,
  sparks      INT UNSIGNED NOT NULL,
  updated_by  BIGINT UNSIGNED NULL,
  updated_at  DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Login streak per playable profile on America/New_York game days (DST-aware).
--   current_streak   consecutive game days the app was opened, ending on last_active_day
--   unclaimed        bonus collected since the last claim; lost when the streak breaks
--   lost_unclaimed   what the last break took away (shown once, for transparency)
CREATE TABLE IF NOT EXISTS profile_streaks (
  profile_id       BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  current_streak   INT UNSIGNED NOT NULL DEFAULT 0,
  best_streak      INT UNSIGNED NOT NULL DEFAULT 0,
  last_active_day  DATE NULL,
  unclaimed        INT UNSIGNED NOT NULL DEFAULT 0,
  lost_unclaimed   INT UNSIGNED NOT NULL DEFAULT 0,
  last_claimed_at  DATETIME NULL,
  updated_at       DATETIME NULL,
  CONSTRAINT fk_profile_streaks_profile FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- News & Updates (Admin Panel: Full Admin + Content Editor). Shown in the app when active and publish_at has passed.
CREATE TABLE IF NOT EXISTS news (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  title_en    VARCHAR(150) NOT NULL,
  title_gu    VARCHAR(150) NULL,
  body_en     TEXT NOT NULL,
  body_gu     TEXT NULL,
  image_url   VARCHAR(500) NULL,
  publish_at  DATETIME NOT NULL,
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  is_pinned   TINYINT(1) NOT NULL DEFAULT 0,
  created_by  BIGINT UNSIGNED NULL,
  updated_by  BIGINT UNSIGNED NULL,
  created_at  DATETIME NOT NULL,
  updated_at  DATETIME NULL,
  KEY idx_news_feed (is_active, publish_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Feedback from the app (bug | idea | other), sent for one playable profile. Deleted with the profile / account.
CREATE TABLE IF NOT EXISTS feedback (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  account_id   BIGINT UNSIGNED NOT NULL,
  profile_id   BIGINT UNSIGNED NOT NULL,
  category     ENUM('bug','idea','other') NOT NULL,
  message      VARCHAR(1000) NOT NULL,
  app_version  VARCHAR(32) NULL,
  device       VARCHAR(100) NULL,
  status       ENUM('open','resolved') NOT NULL DEFAULT 'open',
  admin_note   VARCHAR(500) NULL,
  resolved_by  BIGINT UNSIGNED NULL,
  resolved_at  DATETIME NULL,
  created_at   DATETIME NOT NULL,
  KEY idx_feedback_status (status, id),
  KEY idx_feedback_account (account_id, created_at),
  CONSTRAINT fk_feedback_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  CONSTRAINT fk_feedback_profile FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
