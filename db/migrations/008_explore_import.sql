-- Explore → account (client, 30 Oct 2026): someone who tried the app in Explore mode (no account, data on the device
-- only) brings what they earned and did into their new account with POST /me/explore-import.
--
-- explore_imports: one row per account (an account imports once). The nickname / avatar / path were applied to the
-- target profile when the row was written; nothing personal is stored here.
CREATE TABLE IF NOT EXISTS explore_imports (
  account_id   BIGINT UNSIGNED NOT NULL,
  profile_id   BIGINT UNSIGNED NOT NULL,
  items        INT NOT NULL DEFAULT 0,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (account_id),
  KEY idx_explore_imports_profile (profile_id),
  CONSTRAINT fk_explore_import_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  CONSTRAINT fk_explore_import_profile FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Every Explore entry (Sparks, purchase, score, Learn/Quiz progress), keyed by its unique transaction id from the
-- device, so a retry or a second upload never counts twice. The server stays the final authority: entries wait as
-- 'pending_import' until Milestone 2 (Sparks ledger, Dress Up) / Milestone 3 (scores, progress) verifies them and
-- sets 'credited' or 'rejected'. Belongs to the playable profile (deleted with it).
CREATE TABLE IF NOT EXISTS explore_import_items (
  tx_id        CHAR(36) NOT NULL,
  account_id   BIGINT UNSIGNED NOT NULL,
  profile_id   BIGINT UNSIGNED NOT NULL,
  kind         ENUM('sparks','purchase','score','progress') NOT NULL,
  code         VARCHAR(40) NOT NULL,          -- reason (sparks), item id (purchase), game (score), area (progress)
  item_id      VARCHAR(40) NULL,              -- quiz / puzzle / level / lesson
  amount       INT NOT NULL DEFAULT 0,        -- Sparks earned, price paid, score or progress value
  client_at    DATETIME NOT NULL,             -- when it happened on the device (UTC), as reported
  status       ENUM('pending_import','credited','rejected') NOT NULL DEFAULT 'pending_import',
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at   DATETIME NULL,
  PRIMARY KEY (tx_id),
  KEY idx_explore_items_profile (profile_id, kind, status),
  CONSTRAINT fk_explore_item_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  CONSTRAINT fk_explore_item_profile FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
