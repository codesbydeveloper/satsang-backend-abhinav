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
 * Nothing personal is kept or logged: the deletion_requests row keeps only ids, the account type, the source and
 * the number of profiles deleted.
 */

/**
 * Delete an account and all its data. Call inside tx(). Closes a pending request for the account (e.g. a web-page
 * request still waiting for approval) or, when there is none and `source` is given, records a completed one.
 * @param {{query: Function}} c   transaction connection
 * @param {{id: number, account_type: string}} account
 * @param {{source?: 'app'|'web', decidedBy?: number|null, note?: string|null}} opts
 * @returns {Promise<{profilesDeleted: number, requestId: number|null}>}
 */
async function deleteAccountCompletely(c, account, { source = null, decidedBy = null, note = null } = {}) {
  const profilesDeleted = Number((await c.query('SELECT COUNT(*) AS n FROM profiles WHERE account_id = ?', [account.id]))[0].n);
  await c.query('DELETE FROM accounts WHERE id = ?', [account.id]);   // cascades: profiles + their data, tokens, codes

  const pending = (await c.query("SELECT id FROM account_deletion_requests WHERE account_id = ? AND status = 'pending' FOR UPDATE", [account.id]))[0];
  if (pending) {
    await c.query("UPDATE account_deletion_requests SET status = 'completed', profiles_deleted = ?, decided_by = ?, decided_at = UTC_TIMESTAMP(), decision_note = ? WHERE id = ?",
      [profilesDeleted, decidedBy, note, pending.id]);
    return { profilesDeleted, requestId: pending.id };
  }
  if (!source) return { profilesDeleted, requestId: null };
  const r = await c.query(
    "INSERT INTO account_deletion_requests (account_id, account_type, source, status, profiles_deleted, decided_by, decided_at, decision_note) VALUES (?,?,?,'completed',?,?,UTC_TIMESTAMP(),?)",
    [account.id, account.account_type, source, profilesDeleted, decidedBy, note]);
  return { profilesDeleted, requestId: r.insertId };
}

/**
 * Delete one child profile and everything it owns (cascade on profile_id). Every device session playing as that
 * child is ended (revoked, not moved to the parent area: that would open the parent area without the PIN).
 * Call inside tx(). Returns how many sessions were ended.
 */
async function deleteChildProfile(c, accountId, profileId) {
  const r = await c.query('UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP() WHERE account_id = ? AND profile_id = ? AND revoked_at IS NULL', [accountId, profileId]);
  await c.query('DELETE FROM profiles WHERE id = ? AND account_id = ?', [profileId, accountId]);
  return r.affectedRows || 0;
}

module.exports = { deleteAccountCompletely, deleteChildProfile };
