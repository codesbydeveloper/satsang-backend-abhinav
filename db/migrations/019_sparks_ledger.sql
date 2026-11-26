-- Sparks Economy core ledger (Milestone 2, contract 8.1). All DATETIMEs are UTC (set explicitly with UTC_TIMESTAMP():
-- the migrate script's connection is not pinned to UTC).
--
-- sparks_transactions: every Sparks movement of ONE playable profile (never pooled across a parent account).
--   amount           + earned / credited, - spent or deducted
--   type             signup_bonus, student_verified, student_interest, referral, explore_import, daily_spin, streak,
--                    quiz, game, puzzle, learn, purchase, admin_adjust (list in src/services/sparks.js; VARCHAR so a
--                    new activity needs no schema change)
--   status           verified (counts in the balance) | pending (offline / waiting, e.g. a referrer's reward until the
--                    referred user's first quiz) | reversed (undone; counts nowhere)
--   transaction_id   UNIQUE, client- (UUID from the device) or server-generated (e.g. "signup_bonus-account-12"), stored
--                    lower case: the same id is never processed twice
--   reference        what it was for (item id, attempt id, "account:12", ...)
--   created_by       admins.id for admin adjustments / admin-triggered rewards, else NULL
--   reversed_from    the status the row had before it was reversed
-- Belongs to the profile: deleted with it (ON DELETE CASCADE).
CREATE TABLE IF NOT EXISTS sparks_transactions (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  profile_id       BIGINT UNSIGNED NOT NULL,
  amount           INT NOT NULL,
  type             VARCHAR(32) NOT NULL,
  status           ENUM('verified','pending','reversed') NOT NULL,
  transaction_id   VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reference        VARCHAR(100) NULL,
  note             VARCHAR(255) NULL,
  created_by       BIGINT UNSIGNED NULL,
  created_at       DATETIME NOT NULL,
  verified_at      DATETIME NULL,
  reversed_at      DATETIME NULL,
  reversed_by      BIGINT UNSIGNED NULL,
  reversed_reason  VARCHAR(255) NULL,
  reversed_from    ENUM('verified','pending') NULL,
  UNIQUE KEY uq_sparks_tx_id (transaction_id),
  KEY idx_sparks_tx_profile (profile_id, id),
  KEY idx_sparks_tx_type (type, status),
  CONSTRAINT fk_sparks_tx_profile FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE,
  CONSTRAINT chk_sparks_tx_amount CHECK (amount <> 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One balance row per playable profile, kept equal to its ledger inside the same row-locked DB transaction:
--   balance          Σ verified amounts                         (never below zero)
--   lifetime_earned  Σ verified amounts that are not spending   (leaderboards: spending never lowers it)
--   lifetime_spent   Σ |verified spending|                      (purchases)
--   pending          Σ pending amounts                          (offline Sparks waiting for verification)
-- A negative admin adjustment is a correction: it lowers balance and lifetime_earned, not lifetime_spent.
CREATE TABLE IF NOT EXISTS profile_sparks (
  profile_id       BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  balance          INT UNSIGNED NOT NULL DEFAULT 0,
  lifetime_earned  INT UNSIGNED NOT NULL DEFAULT 0,
  lifetime_spent   INT UNSIGNED NOT NULL DEFAULT 0,
  pending          INT UNSIGNED NOT NULL DEFAULT 0,
  updated_at       DATETIME NULL,
  CONSTRAINT fk_profile_sparks_profile FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Sparks per activity AND per age group, changed by a Full Admin in the Admin Panel (no app release). default_sparks
-- is the seeded value; is_default = 1 until an admin changes the row. The seeded values are placeholders TO BE
-- CONFIRMED BY LOYADHAM: ages up to 18 earn more for Games and less for Puzzles, 19+ the other way round, Quizzes high
-- for everyone.
CREATE TABLE IF NOT EXISTS sparks_reward_config (
  activity         VARCHAR(32) NOT NULL,
  age_group        VARCHAR(40) NOT NULL,
  sparks           INT UNSIGNED NOT NULL,
  default_sparks   INT UNSIGNED NOT NULL,
  is_default       TINYINT(1) NOT NULL DEFAULT 1,
  updated_by       BIGINT UNSIGNED NULL,
  updated_at       DATETIME NULL,
  PRIMARY KEY (activity, age_group)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO sparks_reward_config (activity, age_group, sparks, default_sparks) VALUES
  ('quiz',   'Shishu', 20, 20), ('game',   'Shishu', 15, 15), ('puzzle', 'Shishu', 5, 5), ('learn', 'Shishu', 10, 10),
  ('quiz',   'Bals/Balikas A', 20, 20), ('game', 'Bals/Balikas A', 15, 15), ('puzzle', 'Bals/Balikas A', 5, 5), ('learn', 'Bals/Balikas A', 10, 10),
  ('quiz',   'Bals/Balikas B', 20, 20), ('game', 'Bals/Balikas B', 15, 15), ('puzzle', 'Bals/Balikas B', 5, 5), ('learn', 'Bals/Balikas B', 10, 10),
  ('quiz',   'Bals/Balikas C', 20, 20), ('game', 'Bals/Balikas C', 15, 15), ('puzzle', 'Bals/Balikas C', 5, 5), ('learn', 'Bals/Balikas C', 10, 10),
  ('quiz',   'Kishors/Kishoris A', 20, 20), ('game', 'Kishors/Kishoris A', 15, 15), ('puzzle', 'Kishors/Kishoris A', 5, 5), ('learn', 'Kishors/Kishoris A', 10, 10),
  ('quiz',   'Kishors/Kishoris B', 20, 20), ('game', 'Kishors/Kishoris B', 15, 15), ('puzzle', 'Kishors/Kishoris B', 5, 5), ('learn', 'Kishors/Kishoris B', 10, 10),
  ('quiz',   'Yuvak/Yuvatis A', 20, 20), ('game', 'Yuvak/Yuvatis A', 5, 5), ('puzzle', 'Yuvak/Yuvatis A', 15, 15), ('learn', 'Yuvak/Yuvatis A', 10, 10),
  ('quiz',   'Yuvaks/Yuvatis B', 20, 20), ('game', 'Yuvaks/Yuvatis B', 5, 5), ('puzzle', 'Yuvaks/Yuvatis B', 15, 15), ('learn', 'Yuvaks/Yuvatis B', 10, 10),
  ('quiz',   'Vadil', 20, 20), ('game', 'Vadil', 5, 5), ('puzzle', 'Vadil', 15, 15), ('learn', 'Vadil', 10, 10);
