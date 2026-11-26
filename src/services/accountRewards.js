const sparks = require('./sparks');

/**
 * Account-level Sparks rewards (sign-up bonus, referrals) → the ledger of a playable profile.
 *
 * The reward is earned by the account, but Sparks belong to a playable profile (contract): it goes to the account's
 * FIRST profile (MIN(profiles.id): an independent account's own profile, or a parent's first child). Until the account
 * has a profile the reward stays recorded (signup_bonuses 'pending', referrals 'reserved' / no ledger row) and this
 * function credits it as soon as one exists. Open question for Loyadham: which child of a parent account receives it.
 *
 * Transaction ids are the same as in migration 020, so nothing is ever paid twice:
 *   signup_bonus-account-<accountId>   100 sign-up Sparks, verified
 *   referral-new-<referralId>          new user's referral Sparks, verified at once
 *   referral-referrer-<referralId>     referrer's Sparks: PENDING until the new user's first completed quiz
 *                                      (referrals.onFirstQuizCompleted, Milestone 3), then verified
 *
 * Call inside the caller's tx() (`c`): after email verification, profile creation, and applying a referral code.
 */

/** The profile that receives an account's rewards, or null. */
async function rewardProfileId(c, accountId) {
  const r = (await c.query('SELECT MIN(id) AS id FROM profiles WHERE account_id = ?', [accountId]))[0];
  return r && r.id ? Number(r.id) : null;
}

async function settleAccountRewards(c, accountId) {
  const profileId = await rewardProfileId(c, accountId);
  if (!profileId) return { profileId: null, credited: 0, pending: 0 };
  let credited = 0, pending = 0;

  const bonus = (await c.query("SELECT sparks FROM signup_bonuses WHERE account_id = ? AND status = 'pending' FOR UPDATE", [accountId]))[0];
  if (bonus) {
    if (bonus.sparks > 0) {
      const r = await sparks.credit({ profileId, amount: Number(bonus.sparks), type: 'signup_bonus', transactionId: `signup_bonus-account-${accountId}`,
        reference: `account:${accountId}`, note: 'Sign-up bonus' }, c);
      if (!r.duplicate) credited += Number(bonus.sparks);
    }
    await c.query("UPDATE signup_bonuses SET status = 'credited', credited_at = UTC_TIMESTAMP() WHERE account_id = ?", [accountId]);
  }

  // this account joined with a friend's code: its own reward, at once
  const joined = (await c.query("SELECT id, new_user_sparks FROM referrals WHERE referee_account_id = ? AND new_user_status = 'reserved' FOR UPDATE", [accountId]))[0];
  if (joined) {
    if (joined.new_user_sparks > 0) {
      const r = await sparks.credit({ profileId, amount: Number(joined.new_user_sparks), type: 'referral', transactionId: `referral-new-${joined.id}`,
        reference: `referral:${joined.id}`, note: "Referral: joined with a friend's code" }, c);
      if (!r.duplicate) credited += Number(joined.new_user_sparks);
    }
    await c.query("UPDATE referrals SET new_user_status = 'credited' WHERE id = ?", [joined.id]);
  }

  // friends who used this account's code: pending until their first quiz; verified once they qualified
  const mine = await c.query(
    "SELECT id, status, referrer_sparks FROM referrals WHERE referrer_account_id = ? AND status IN ('waiting_for_first_quiz','qualified') AND referrer_sparks > 0 FOR UPDATE",
    [accountId]);
  for (const rf of mine) {
    const o = { profileId, amount: Number(rf.referrer_sparks), type: 'referral', transactionId: `referral-referrer-${rf.id}`,
      reference: `referral:${rf.id}`, note: 'Referral: a friend joined with your code' };
    const p = await sparks.addPending(o, c);
    if (rf.status === 'qualified') {
      if (p.transaction.status === 'pending') {
        await sparks.verifyPending(o.transactionId, c);
        credited += o.amount;
      }
      if (p.transaction.status !== 'reversed') {
        await c.query("UPDATE referrals SET status = 'credited', credited_at = UTC_TIMESTAMP() WHERE id = ?", [rf.id]);
      }
    } else if (!p.duplicate) pending += o.amount;
  }
  return { profileId, credited, pending };
}

module.exports = { rewardProfileId, settleAccountRewards };
