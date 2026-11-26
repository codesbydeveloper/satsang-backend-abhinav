const { query, tx } = require('../db');
const { settleAccountRewards } = require('../services/accountRewards');

/** Sparks promised on the Sign Up screen ("Receive 100 Sparks"). */
const SIGNUP_BONUS_SPARKS = 100;

/**
 * Gives the sign-up bonus when the account's email is verified: one signup_bonuses row per account (the primary key
 * makes a second verification, or a retry, a no-op), credited at once to the Sparks ledger of the account's first
 * playable profile (transaction id "signup_bonus-account-<id>", status 'credited'). An account without a profile yet
 * (a parent before the first child, an independent user before Profile setup) keeps it 'pending' until its first
 * profile is created (services/accountRewards.settleAccountRewards). Open question for Loyadham: which child of a
 * parent account receives it (today: the first child).
 */
async function grantSignupBonus(accountId, conn = null) {
  const work = async (c) => {
    await c.query('INSERT IGNORE INTO signup_bonuses (account_id, sparks, status) VALUES (?, ?, \'pending\')', [accountId, SIGNUP_BONUS_SPARKS]);
    return settleAccountRewards(c, accountId);
  };
  return conn ? work(conn) : tx(work);
}

/** { sparks, status } for the account owner (GET /me), or null before the email is verified. */
async function signupBonusOf(accountId) {
  const row = (await query('SELECT sparks, status FROM signup_bonuses WHERE account_id = ?', [accountId]))[0];
  return row ? { sparks: row.sparks, status: row.status } : null;
}

module.exports = { SIGNUP_BONUS_SPARKS, grantSignupBonus, signupBonusOf };
