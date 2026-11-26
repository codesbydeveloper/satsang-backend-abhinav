const crypto = require('crypto');
const config = require('../config');
const { query, tx } = require('../db');
const { settleAccountRewards } = require('../services/accountRewards');
const { badRequest, conflict, forbidden } = require('./errors');
const { readSettings } = require('./appSettings');

/**
 * Referrals (contract 8.3 + client rules, 30 Oct 2026).
 * - Every account has a unique short code (6 characters, no 0 / O / 1 / I) at account level, never per profile.
 * - A new account applies one friend's code, within referral_window_hours (48) of creating the account.
 * - New user: +referral_new_user_sparks (25) credited at once. Referrer: +referral_referrer_sparks (50) only after the
 *   new user completes their first full quiz: a PENDING ledger row while 'waiting_for_first_quiz', verified by
 *   onFirstQuizCompleted (Milestone 3). Both go through the Sparks ledger (services/accountRewards.js), to the
 *   account's first playable profile (kept reserved while the account has none).
 * - Refused: unknown code (INVALID_CODE), own code or the same mailbox (SELF_REFERRAL), a second code for the account
 *   or from the same phone (ALREADY_APPLIED), too late (WINDOW_EXPIRED), referrer at referral_max_per_referrer
 *   (REFERRER_LIMIT; unlimited by default).
 * Codes are never logged.
 */

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';   // 32 characters: no 0, O, 1 or I
const CODE_LENGTH = 6;

function newCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) s += ALPHABET[bytes[i] % ALPHABET.length];   // 256 % 32 = 0: no bias
  return s;
}

/** What a person typed → the stored form (trimmed, upper case, spaces and dashes removed). */
const normalizeCode = (s) => String(s || '').toUpperCase().replace(/[\s-]/g, '');

const isWellFormed = (code) => code.length === CODE_LENGTH && [...code].every((ch) => ALPHABET.includes(ch));

/** The account's code, created on first use (unique; a clash is retried). */
async function ensureReferralCode(accountId) {
  const row = (await query('SELECT referral_code FROM accounts WHERE id = ?', [accountId]))[0];
  if (!row) return null;
  if (row.referral_code) return row.referral_code;
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = newCode();
    try {
      const r = await query('UPDATE accounts SET referral_code = ? WHERE id = ? AND referral_code IS NULL', [code, accountId]);
      if (r.affectedRows) return code;
      return (await query('SELECT referral_code FROM accounts WHERE id = ?', [accountId]))[0].referral_code;   // set meanwhile
    } catch (e) {
      if (e.code !== 'ER_DUP_ENTRY') throw e;   // another account has it: try a new one
    }
  }
  throw new Error('Could not create a unique referral code');
}

/** The same mailbox written differently: case, "+tag", and dots in Gmail addresses. */
function mailboxKey(email) {
  const [local, domain] = String(email || '').toLowerCase().split('@');
  if (!domain) return String(email || '').toLowerCase();
  let l = local.split('+')[0];
  const d = domain === 'googlemail.com' ? 'gmail.com' : domain;
  if (d === 'gmail.com') l = l.replace(/\./g, '');
  return `${l}@${d}`;
}

/** HMAC of the app's random install id (never stored in clear; not a hardware id). */
const deviceHash = (deviceId) => (deviceId
  ? crypto.createHmac('sha256', config.jwtSecret).update('referral-device:' + deviceId).digest('hex')
  : null);

/** Seconds since the account was created, measured by MySQL's UTC clock (created_at is stored in UTC). */
async function accountAgeSeconds(q, accountId) {
  const row = (await q("SELECT TIMESTAMPDIFF(SECOND, created_at, UTC_TIMESTAMP()) AS age FROM accounts WHERE id = ?", [accountId]))[0];
  return row ? Number(row.age) : Infinity;
}

/** Until when the account may still apply a code (ISO, UTC). */
const applyUntil = (ageSeconds, windowHours, now = Date.now()) => new Date(now + (windowHours * 3600 - ageSeconds) * 1000).toISOString();

/**
 * Applies a code for `account` (a row of accounts). Call inside tx(); `c.query` returns rows.
 * Returns the new referral row's public view.
 */
async function applyReferral(c, account, rawCode, deviceId) {
  const s = await readSettings(undefined, c);
  const code = normalizeCode(rawCode);
  if (!isWellFormed(code)) throw badRequest('INVALID_CODE', 'That referral code was not found');
  if ((await c.query('SELECT 1 FROM referrals WHERE referee_account_id = ? FOR UPDATE', [account.id])).length) {
    throw conflict('ALREADY_APPLIED', 'A referral code was already used for this account');
  }
  if (await accountAgeSeconds(c.query, account.id) > s.referral_window_hours * 3600) {
    throw forbidden('WINDOW_EXPIRED', `Referral codes can be entered within ${s.referral_window_hours} hours of creating the account`);
  }
  const referrer = (await c.query('SELECT id, email FROM accounts WHERE referral_code = ? FOR UPDATE', [code]))[0];
  if (!referrer) throw badRequest('INVALID_CODE', 'That referral code was not found');
  if (referrer.id === account.id || mailboxKey(referrer.email) === mailboxKey(account.email)) {
    throw badRequest('SELF_REFERRAL', 'You cannot use your own referral code');
  }
  const device = deviceHash(deviceId);
  if (device && (await c.query('SELECT 1 FROM referrals WHERE device_hash = ? LIMIT 1', [device])).length) {
    throw conflict('ALREADY_APPLIED', 'A referral code was already used on this device');
  }
  if (s.referral_max_per_referrer !== null) {
    const used = Number((await c.query("SELECT COUNT(*) AS n FROM referrals WHERE referrer_account_id = ? AND status <> 'rejected'", [referrer.id]))[0].n);
    if (used >= s.referral_max_per_referrer) throw conflict('REFERRER_LIMIT', 'This referral code cannot be used any more');
  }
  const r = await c.query(
    `INSERT INTO referrals (referrer_account_id, referee_account_id, code, new_user_sparks, referrer_sparks, device_hash)
     VALUES (?,?,?,?,?,?)`,
    [referrer.id, account.id, code, s.referral_new_user_sparks, s.referral_referrer_sparks, device]);
  // Sparks ledger: the new user's reward now (transaction id "referral-new-<id>"), the referrer's as pending
  // ("referral-referrer-<id>"). 'reserved' remains only while the new account has no playable profile yet.
  await settleAccountRewards(c, account.id);
  await settleAccountRewards(c, referrer.id);
  const st = (await c.query('SELECT new_user_status FROM referrals WHERE id = ?', [r.insertId]))[0].new_user_status;
  return { id: r.insertId, sparks: s.referral_new_user_sparks, status: st };
}

/** GET /me/referral for the account owner: own code, counts (no names) and the code this account used. */
async function referralView(account) {
  const s = await readSettings();
  const code = await ensureReferralCode(account.id);
  const counts = await query('SELECT status, COUNT(*) AS n FROM referrals WHERE referrer_account_id = ? GROUP BY status', [account.id]);
  const by = Object.fromEntries(counts.map((r) => [r.status, Number(r.n)]));
  const used = (await query('SELECT code, new_user_sparks, new_user_status, created_at FROM referrals WHERE referee_account_id = ?', [account.id]))[0];
  const age = await accountAgeSeconds(query, account.id);
  const open = age <= s.referral_window_hours * 3600;
  return {
    code,
    newUserSparks: s.referral_new_user_sparks,
    referrerSparks: s.referral_referrer_sparks,
    windowHours: s.referral_window_hours,
    counts: {
      total: Object.values(by).reduce((a, b) => a + b, 0) - (by.rejected || 0),
      waitingForFirstQuiz: by.waiting_for_first_quiz || 0,
      qualified: (by.qualified || 0) + (by.credited || 0),
      sparksPending: (by.qualified || 0) * s.referral_referrer_sparks,
      sparksCredited: Number((await query("SELECT COALESCE(SUM(referrer_sparks), 0) AS n FROM referrals WHERE referrer_account_id = ? AND status = 'credited'", [account.id]))[0].n),
    },
    applied: used ? { code: used.code, sparks: used.new_user_sparks, status: used.new_user_status } : null,
    canApply: !used && open,
    applyUntil: applyUntil(age, s.referral_window_hours),
  };
}

/**
 * Milestone 3 hook: call once a profile has completed its first full quiz. If its account was referred and the
 * referrer is still waiting, the referral becomes 'qualified' and the referrer's pending ledger row is verified
 * (status 'credited'; it stays 'qualified' while the referrer has no profile yet). Pass the quiz endpoint's tx
 * connection `c` to make it part of the same transaction.
 * TODO(M3 Quizzes): call from the quiz-completion endpoint.
 * @returns {Promise<boolean>} true when a referral qualified now
 */
async function onFirstQuizCompleted(profileId, c) {
  const work = async (cc) => {
    const rf = (await cc.query(
      `SELECT rf.id, rf.referrer_account_id FROM referrals rf JOIN profiles p ON p.account_id = rf.referee_account_id
       WHERE p.id = ? AND rf.status = 'waiting_for_first_quiz' AND rf.referrer_account_id IS NOT NULL FOR UPDATE`, [profileId]))[0];
    if (!rf) return false;
    await cc.query("UPDATE referrals SET status = 'qualified', qualified_at = UTC_TIMESTAMP() WHERE id = ?", [rf.id]);
    await settleAccountRewards(cc, rf.referrer_account_id);
    return true;
  };
  return c ? work(c) : tx(work);
}

module.exports = { ALPHABET, CODE_LENGTH, newCode, normalizeCode, ensureReferralCode, mailboxKey, applyReferral, referralView, onFirstQuizCompleted, applyUntil };
