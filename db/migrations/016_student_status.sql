-- Student status (client, 21 Nov 2026): during profile setup each playable profile (an independent account's own
-- profile, and each child profile separately) answers "Currently enrolled in Loyadham Online Classes (Bals-Balikas or
-- Kishor-Kishori Classes)?". A Full Admin then verifies an enrolment or confirms an interest, which rewards Sparks.
--
-- student_status:
--   not_asked             existing profiles, and after an admin reset
--   pending_verification  the profile said "enrolled"; waits for a Full Admin (verify → verified, reject → not_enrolled)
--   verified              enrolment confirmed by a Full Admin (+STUDENT_VERIFIED_SPARKS); the app can no longer change it
--   interested            "not enrolled, but interested"; waits for a Full Admin (confirm_interest → interest_confirmed)
--   interest_confirmed    interest confirmed by a Full Admin (+STUDENT_INTEREST_SPARKS); the app can no longer change it
--   not_enrolled          "not enrolled, not interested", or an enrolment the admin rejected
-- student_verified_by / student_verified_at: the Full Admin (admins.id) who last verified / confirmed, and when (UTC).
-- student_sparks_awarded: total Sparks this profile has been given for its student status. A reset never takes them
-- back. All DATETIMEs are UTC.
ALTER TABLE profiles
  ADD COLUMN student_status ENUM('not_asked','pending_verification','verified','interested','interest_confirmed','not_enrolled')
    NOT NULL DEFAULT 'not_asked' AFTER country,
  ADD COLUMN student_status_updated_at DATETIME NULL AFTER student_status,
  ADD COLUMN student_verified_by       BIGINT UNSIGNED NULL AFTER student_status_updated_at,
  ADD COLUMN student_verified_at       DATETIME NULL AFTER student_verified_by,
  ADD COLUMN student_sparks_awarded    INT NOT NULL DEFAULT 0 AFTER student_verified_at,
  ADD KEY idx_profiles_student_status (student_status);

-- Sparks rewards a profile has earned, one row per (profile, reward): the unique key makes a second award of the same
-- reward impossible, even after a reset and a new verification. Like the sign-up bonus, referrals and Explore imports,
-- the Sparks are reserved here and credited by the Milestone 2 Sparks ledger (status 'reserved' → 'credited', with
-- tx_id as the ledger's unique transaction id). Belongs to the playable profile (deleted with it).
CREATE TABLE IF NOT EXISTS profile_sparks_rewards (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  profile_id   BIGINT UNSIGNED NOT NULL,
  reward       ENUM('student_verified','student_interest_confirmed') NOT NULL,
  sparks       INT NOT NULL,
  tx_id        VARCHAR(64) NOT NULL,                 -- e.g. "student_verified-42": unique transaction id for the ledger
  status       ENUM('reserved','credited') NOT NULL DEFAULT 'reserved',
  awarded_by   BIGINT UNSIGNED NULL,                 -- admins.id
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  credited_at  DATETIME NULL,
  UNIQUE KEY uq_profile_reward (profile_id, reward),
  UNIQUE KEY uq_profile_reward_tx (tx_id),
  CONSTRAINT fk_profile_reward_profile FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
