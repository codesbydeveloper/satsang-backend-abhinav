-- Daily time heartbeats (POST /me/activity/heartbeat). One row per profile per UTC minute that had activity, so a
-- heartbeat sent twice (an offline queue retrying) is counted once and no client can count more than real time.
-- The seconds are added to profile_daily_activity for the America/New_York day of the minute. Rows older than
-- 2 days are pruned (the app queues at most 1 day back).
CREATE TABLE IF NOT EXISTS profile_activity_minutes (
  profile_id    BIGINT UNSIGNED NOT NULL,
  minute_start  DATETIME NOT NULL,          -- UTC, seconds = 0
  seconds       TINYINT UNSIGNED NOT NULL,
  PRIMARY KEY (profile_id, minute_start),
  CONSTRAINT fk_activity_minutes_profile FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
