-- Account deletion requests from the app (DELETE /me) and the public delete-account page.
-- A Full Admin approves (the account is then deleted) or rejects each request in the Admin Panel.
-- No email or username is stored here: pending/rejected rows read them live from the account, and a
-- completed row keeps only ids, counts and the decision, so nothing personal survives the deletion.
CREATE TABLE IF NOT EXISTS account_deletion_requests (
  id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  account_id          BIGINT UNSIGNED NOT NULL,          -- no FK: the row outlives the account as the record of its deletion
  account_type        ENUM('adult','parent') NOT NULL,
  source              ENUM('app','web') NOT NULL,
  status              ENUM('pending','completed','rejected') NOT NULL DEFAULT 'pending',
  profiles_deleted    INT UNSIGNED NULL,                 -- set on approval
  decided_by          BIGINT UNSIGNED NULL,              -- admins.id
  decided_at          DATETIME NULL,
  decision_note       VARCHAR(200) NULL,                 -- rejection reason, or optional approval note
  requested_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- at most one pending request per account
  pending_account_id  BIGINT UNSIGNED AS (IF(status = 'pending', account_id, NULL)) STORED,
  UNIQUE KEY uq_deletion_pending (pending_account_id),
  KEY ix_deletion_status (status, requested_at),
  KEY ix_deletion_account (account_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
