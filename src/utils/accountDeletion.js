/**
 * Permanent deletion (contract 3.4), in one place for every path: the app (DELETE /me, DELETE /profiles/:id), a Full
 * Admin approving a web-page request, and the Admin Panel's Users page.
 *
 * Deleting the account row cascades (ON DELETE CASCADE) to its profiles and everything they own — today daily time;
 * from M2 Sparks, Dress Up items, saved Shangars, scores and leaderboard rows, which must use the same cascade on
 * profile_id — and to the account's refresh tokens and email codes, so every device is logged out (the auth middleware
 * also refuses any access token whose account is gone). Anything that points at an account WITHOUT a cascade must be
 * cleared here, inside the same transaction. Referrals: the new user's row cascades; a deleted referrer becomes NULL
 * (ON DELETE SET NULL), so the new user keeps their reward.
 *
 * Nothing personal is kept or logged, with one exception (client approved, 19 Nov 2026; username added 23 Nov 2026):
 * the deletion_requests row keeps the account's email (email_retained) and username (username_retained: the adult's
 * own profile; null for a parent account) until email_retained_until (now + RETAINED_EMAIL_DAYS, default 30), shown to
 * Full Admins only; src/utils/retainedEmails.js erases both after that. Otherwise the row keeps only ids, the account
 * type, the source and the number of profiles deleted.
 *
 * A child profile deleted on its own (deleteChildProfile) is recorded the same way as a completed entry with
 * target 'child_profile': the child's username and the parent's email, for the same period.
 *
 * The owner gets a confirmation email (to the parent's email for a parent account; child profiles have none). It is
 * sent as the last step inside the transaction, before the deletion is committed. A mail failure is logged and never
 * stops the deletion.
 */
const config = require('../config');
const mailer = require('./mailer');

const MAIL_TIMEOUT_MS = 10000;   // don't hold the transaction open on a slow SMTP server
// Retention cut-off for a completed entry: set when an email or a username was kept (params: email, username, days).
const RETAIN_UNTIL = 'IF(? IS NULL AND ? IS NULL, NULL, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? DAY))';

async function sendDeletedEmail(email) {
  let timer;
  try {
    await Promise.race([
      mailer.sendAccountDeletedEmail(email),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), MAIL_TIMEOUT_MS); }),
    ]);
  } catch (err) {
    console.error('account-deleted email failed:', err && err.message);   // no address, no secrets
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Delete an account and all its data. Call inside tx(). Closes a pending request for the account (e.g. a web-page
 * request still waiting for approval) or, when there is none and `source` is given, records a completed one.
 * @param {{query: Function}} c   transaction connection
 * @param {{id: number, account_type: string}} account
 * @param {{source?: 'app'|'web', decidedBy?: number|null, note?: string|null}} opts
 * @returns {Promise<{profilesDeleted: number, requestId: number|null}>}
 */
async function deleteAccountCompletely(c, account, { source = null, decidedBy = null, note = null } = {}) {
  const email = ((await c.query('SELECT email FROM accounts WHERE id = ? FOR UPDATE', [account.id]))[0] || {}).email || null;
  // the adult's own playable profile; a parent account has none (its children are counted, not kept)
  const username = ((await c.query('SELECT username FROM profiles WHERE account_id = ? AND is_child = 0 ORDER BY id LIMIT 1', [account.id]))[0] || {}).username || null;
  const profilesDeleted = Number((await c.query('SELECT COUNT(*) AS n FROM profiles WHERE account_id = ?', [account.id]))[0].n);
  await c.query('DELETE FROM accounts WHERE id = ?', [account.id]);   // cascades: profiles + their data, tokens, codes

  const days = config.retainedEmailDays;
  let requestId = null;
  const pending = (await c.query("SELECT id FROM account_deletion_requests WHERE account_id = ? AND status = 'pending' FOR UPDATE", [account.id]))[0];
  if (pending) {
    await c.query(
      `UPDATE account_deletion_requests SET status = 'completed', profiles_deleted = ?, decided_by = ?, decided_at = UTC_TIMESTAMP(), decision_note = ?,
              email_retained = ?, username_retained = ?, email_retained_until = ${RETAIN_UNTIL} WHERE id = ?`,
      [profilesDeleted, decidedBy, note, email, username, email, username, days, pending.id]);
    requestId = pending.id;
  } else if (source) {
    const r = await c.query(
      `INSERT INTO account_deletion_requests (account_id, account_type, source, status, profiles_deleted, decided_by, decided_at, decision_note, email_retained, username_retained, email_retained_until)
       VALUES (?,?,?,'completed',?,?,UTC_TIMESTAMP(),?,?,?,${RETAIN_UNTIL})`,
      [account.id, account.account_type, source, profilesDeleted, decidedBy, note, email, username, email, username, days]);
    requestId = r.insertId;
  }

  if (email) await sendDeletedEmail(email);
  return { profilesDeleted, requestId };
}

/**
 * Delete ONE child profile and only what it owns: its progress, daily activity, Explore imports and reserved Sparks
 * rewards (all ON DELETE CASCADE on profile_id) and its student status (columns on the profile row). The parent
 * account, its email/password/PIN, its account-level Sparks (sign-up bonus, referrals) and every sibling profile with
 * its own data are untouched: nothing here touches a row of another profile. Every device session playing as that
 * child is ended (revoked, not moved to the parent area: that would open the parent area without the PIN).
 *
 * Records a completed deletion entry (target 'child_profile', account_id = the parent) keeping the child's username
 * and the parent's email for RETAINED_EMAIL_DAYS (Full Admins only), like an account deletion.
 * Call inside tx(). Returns null when the profile is not a child of that account (nothing is deleted).
 * @param {{query: Function}} c
 * @param {{source?: 'app'|'admin', decidedBy?: number|null, note?: string|null}} opts
 * @returns {Promise<{sessionsEnded: number, requestId: number} | null>}
 */
async function deleteChildProfile(c, accountId, profileId, { source = 'app', decidedBy = null, note = null } = {}) {
  const p = (await c.query(
    `SELECT p.id, p.username, a.email, a.account_type FROM profiles p JOIN accounts a ON a.id = p.account_id
      WHERE p.id = ? AND p.account_id = ? AND p.is_child = 1 FOR UPDATE`, [profileId, accountId]))[0];
  if (!p) return null;
  const r = await c.query('UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP() WHERE account_id = ? AND profile_id = ? AND revoked_at IS NULL', [accountId, profileId]);
  await c.query('DELETE FROM profiles WHERE id = ? AND account_id = ? AND is_child = 1', [profileId, accountId]);   // cascades to the child's own data only
  const ins = await c.query(
    `INSERT INTO account_deletion_requests (account_id, account_type, target, profile_id, source, status, profiles_deleted, decided_by, decided_at, decision_note,
       email_retained, username_retained, email_retained_until)
     VALUES (?,?,'child_profile',?,?,'completed',1,?,UTC_TIMESTAMP(),?,?,?,${RETAIN_UNTIL})`,
    [accountId, p.account_type, profileId, source, decidedBy, note, p.email, p.username, p.email, p.username, config.retainedEmailDays]);
  return { sessionsEnded: r.affectedRows || 0, requestId: ins.insertId };
}

module.exports = { deleteAccountCompletely, deleteChildProfile };
