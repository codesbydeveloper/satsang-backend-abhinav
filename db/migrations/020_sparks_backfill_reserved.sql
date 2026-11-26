-- Moves the Sparks RESERVED in Milestone 1 into the ledger (019). Safe to run any number of times: every row gets a
-- deterministic transaction_id (UNIQUE, INSERT IGNORE) and the balances are recomputed from the ledger at the end, so
-- a second run changes nothing. The app code (src/services/sparks.js, src/services/accountRewards.js) uses the SAME
-- transaction ids, so a reward migrated here is never paid again by the code.
--
-- Account-level rewards (sign-up bonus, referrals) go to the account's first playable profile (MIN(profiles.id): an
-- independent account's own profile, or a parent's first child). An account with no profile yet keeps its reward
-- reserved until its first profile is created (accountRewards.settleAccountRewards). Open question for Loyadham.

-- 1. Sign-up bonus (100), once per account → verified.
INSERT IGNORE INTO sparks_transactions (profile_id, amount, type, status, transaction_id, reference, note, created_at, verified_at)
SELECT (SELECT MIN(p.id) FROM profiles p WHERE p.account_id = sb.account_id), sb.sparks, 'signup_bonus', 'verified',
       CONCAT('signup_bonus-account-', sb.account_id), CONCAT('account:', sb.account_id), 'Sign-up bonus',
       sb.created_at, UTC_TIMESTAMP()
FROM signup_bonuses sb
WHERE sb.status = 'pending' AND sb.sparks > 0 AND EXISTS (SELECT 1 FROM profiles p WHERE p.account_id = sb.account_id);

UPDATE signup_bonuses sb
JOIN sparks_transactions t ON t.transaction_id = CONCAT('signup_bonus-account-', sb.account_id)
SET sb.status = 'credited', sb.credited_at = COALESCE(sb.credited_at, UTC_TIMESTAMP())
WHERE sb.status = 'pending';

-- 2. Student status rewards (verified / interest confirmed), per profile → verified. tx_id was already unique.
INSERT IGNORE INTO sparks_transactions (profile_id, amount, type, status, transaction_id, reference, note, created_by, created_at, verified_at)
SELECT r.profile_id, r.sparks, IF(r.reward = 'student_verified', 'student_verified', 'student_interest'), 'verified',
       LOWER(r.tx_id), CONCAT('profile:', r.profile_id),
       IF(r.reward = 'student_verified', 'Student status verified', 'Class interest confirmed'),
       r.awarded_by, r.created_at, UTC_TIMESTAMP()
FROM profile_sparks_rewards r
WHERE r.status = 'reserved' AND r.sparks > 0;

UPDATE profile_sparks_rewards r
JOIN sparks_transactions t ON t.transaction_id = LOWER(r.tx_id)
SET r.status = 'credited', r.credited_at = COALESCE(r.credited_at, UTC_TIMESTAMP())
WHERE r.status = 'reserved';

-- 3. Explore import: the device's Sparks entries → verified, with the device's own transaction id. Purchases, scores
--    and progress stay pending_import (Dress Up / Milestone 3).
INSERT IGNORE INTO sparks_transactions (profile_id, amount, type, status, transaction_id, reference, note, created_at, verified_at)
SELECT i.profile_id, i.amount, 'explore_import', 'verified', LOWER(i.tx_id), LEFT(CONCAT('explore:', i.code), 100),
       'Explore progress', i.created_at, UTC_TIMESTAMP()
FROM explore_import_items i
WHERE i.kind = 'sparks' AND i.status = 'pending_import' AND i.amount > 0;

UPDATE explore_import_items i
JOIN sparks_transactions t ON t.transaction_id = LOWER(i.tx_id) AND t.profile_id = i.profile_id
SET i.status = 'credited', i.decided_at = COALESCE(i.decided_at, UTC_TIMESTAMP())
WHERE i.kind = 'sparks' AND i.status = 'pending_import';

-- 4a. Referral, new user (+25 at once) → verified on the new account's first profile.
INSERT IGNORE INTO sparks_transactions (profile_id, amount, type, status, transaction_id, reference, note, created_at, verified_at)
SELECT (SELECT MIN(p.id) FROM profiles p WHERE p.account_id = rf.referee_account_id), rf.new_user_sparks, 'referral', 'verified',
       CONCAT('referral-new-', rf.id), CONCAT('referral:', rf.id), 'Referral: joined with a friend''s code',
       rf.created_at, UTC_TIMESTAMP()
FROM referrals rf
WHERE rf.new_user_status = 'reserved' AND rf.new_user_sparks > 0
  AND EXISTS (SELECT 1 FROM profiles p WHERE p.account_id = rf.referee_account_id);

UPDATE referrals rf
JOIN sparks_transactions t ON t.transaction_id = CONCAT('referral-new-', rf.id)
SET rf.new_user_status = 'credited'
WHERE rf.new_user_status = 'reserved';

-- 4b. Referral, referrer (+50): stays PENDING until the referred user's first completed quiz (Milestone 3);
--     already qualified → verified (status 'credited').
INSERT IGNORE INTO sparks_transactions (profile_id, amount, type, status, transaction_id, reference, note, created_at, verified_at)
SELECT (SELECT MIN(p.id) FROM profiles p WHERE p.account_id = rf.referrer_account_id), rf.referrer_sparks, 'referral',
       IF(rf.status = 'qualified', 'verified', 'pending'),
       CONCAT('referral-referrer-', rf.id), CONCAT('referral:', rf.id), 'Referral: a friend joined with your code',
       rf.created_at, IF(rf.status = 'qualified', UTC_TIMESTAMP(), NULL)
FROM referrals rf
WHERE rf.status IN ('waiting_for_first_quiz', 'qualified') AND rf.referrer_sparks > 0 AND rf.referrer_account_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM profiles p WHERE p.account_id = rf.referrer_account_id);

UPDATE referrals rf
JOIN sparks_transactions t ON t.transaction_id = CONCAT('referral-referrer-', rf.id) AND t.status = 'verified'
SET rf.status = 'credited', rf.credited_at = COALESCE(rf.credited_at, UTC_TIMESTAMP())
WHERE rf.status = 'qualified';

-- 5. Balances = the ledger (idempotent recomputation; every profile gets its row).
INSERT INTO profile_sparks (profile_id, balance, lifetime_earned, lifetime_spent, pending, updated_at)
SELECT p.id,
       COALESCE(SUM(CASE WHEN t.status = 'verified' THEN t.amount END), 0),
       COALESCE(SUM(CASE WHEN t.status = 'verified' AND NOT (t.amount < 0 AND t.type <> 'admin_adjust') THEN t.amount END), 0),
       COALESCE(SUM(CASE WHEN t.status = 'verified' AND t.amount < 0 AND t.type <> 'admin_adjust' THEN -t.amount END), 0),
       COALESCE(SUM(CASE WHEN t.status = 'pending' THEN t.amount END), 0),
       UTC_TIMESTAMP()
FROM profiles p
LEFT JOIN sparks_transactions t ON t.profile_id = p.id
GROUP BY p.id
ON DUPLICATE KEY UPDATE balance = VALUES(balance), lifetime_earned = VALUES(lifetime_earned),
                        lifetime_spent = VALUES(lifetime_spent), pending = VALUES(pending), updated_at = VALUES(updated_at);
