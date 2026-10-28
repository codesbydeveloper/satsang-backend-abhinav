const { query } = require('../db');

/** Sparks promised on the Sign Up screen ("Receive 100 Sparks"). */
const SIGNUP_BONUS_SPARKS = 100;

/**
 * Reserves the sign-up bonus when the account's email is verified: one 'pending' row per account (the primary key
 * makes a second verification, or a retry, a no-op).
 * TODO(M2 Sparks ledger): credit the pending bonus to the Sparks ledger (unique transaction id per account) and set
 * status 'credited' + credited_at. Open question for Loyadham: which profile of a parent account receives it.
 */
async function reserveSignupBonus(accountId, conn = null) {
  const sql = 'INSERT IGNORE INTO signup_bonuses (account_id, sparks, status) VALUES (?, ?, \'pending\')';
  if (conn) await conn.query(sql, [accountId, SIGNUP_BONUS_SPARKS]);
  else await query(sql, [accountId, SIGNUP_BONUS_SPARKS]);
}

/** { sparks, status } for the account owner (GET /me), or null before the email is verified. */
async function signupBonusOf(accountId) {
  const row = (await query('SELECT sparks, status FROM signup_bonuses WHERE account_id = ?', [accountId]))[0];
  return row ? { sparks: row.sparks, status: row.status } : null;
}

module.exports = { SIGNUP_BONUS_SPARKS, reserveSignupBonus, signupBonusOf };
