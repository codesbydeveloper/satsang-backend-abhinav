-- Per-profile daily activity, used for the parent time report. "game_day" is the America/New_York calendar day.
-- The counters other than active_seconds are filled by later milestones (Learn, Quizzes, Games, Sparks).
CREATE TABLE IF NOT EXISTS profile_daily_activity (
  profile_id         BIGINT UNSIGNED NOT NULL,
  game_day           DATE NOT NULL,
  active_seconds     INT UNSIGNED NOT NULL DEFAULT 0,
  learn_items_done   INT UNSIGNED NOT NULL DEFAULT 0,
  quizzes_completed  INT UNSIGNED NOT NULL DEFAULT 0,
  games_played       INT UNSIGNED NOT NULL DEFAULT 0,
  sparks_earned      INT UNSIGNED NOT NULL DEFAULT 0,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (profile_id, game_day),
  CONSTRAINT fk_activity_profile FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
