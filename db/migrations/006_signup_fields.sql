-- Sign Up asks First name, Last name and Gender (client change, Oct 2026). They belong to the account owner only:
-- private like the DOB (only the username is public). Returned by GET /me to the owner and on the Admin Panel's user
-- detail page, never in any public, leaderboard or admin list output, never logged. Parent accounts give the parent's
-- own name; children's profiles keep only a username.
ALTER TABLE accounts
  ADD COLUMN first_name VARCHAR(50) NULL AFTER preferred_language,
  ADD COLUMN last_name  VARCHAR(50) NULL AFTER first_name,
  ADD COLUMN gender     ENUM('male','female','prefer_not_to_say') NULL AFTER last_name;

-- "Receive 100 Sparks" for signing up: reserved when the email is verified (one row per account), credited to the
-- Sparks ledger in Milestone 2 (status 'credited', credited_at). Deleting the account deletes the row.
CREATE TABLE IF NOT EXISTS signup_bonuses (
  account_id   BIGINT UNSIGNED NOT NULL,
  sparks       INT NOT NULL DEFAULT 100,
  status       ENUM('pending','credited') NOT NULL DEFAULT 'pending',
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  credited_at  DATETIME NULL,
  PRIMARY KEY (account_id),
  CONSTRAINT fk_signup_bonus_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
