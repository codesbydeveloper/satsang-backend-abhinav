const bcrypt = require('bcryptjs');
const config = require('../config');
const { query } = require('../db');
const { toSql, addMinutes, fromSql } = require('./time');
const { ApiError, conflict } = require('./errors');

const MAX_FAILS = 5;
const LOCK_MINUTES = 5;

const lockedError = (until) => new ApiError(429, 'PIN_LOCKED',
  `Too many wrong PIN attempts. Try again in ${LOCK_MINUTES} minutes, or reset the PIN with your password.`,
  { retryAfterSeconds: Math.max(1, Math.ceil((until.getTime() - Date.now()) / 1000)) });

/**
 * Verify the Parent PIN with brute-force protection: 5 wrong tries lock it for 5 minutes. Throws PIN_NOT_SET (409),
 * PIN_LOCKED (429, details.retryAfterSeconds) or PIN_INCORRECT (401, details.attemptsLeft). The PIN is never returned.
 */
async function verifyPin(account, pin) {
  if (!account.parent_pin_hash) throw conflict('PIN_NOT_SET', 'Create a Parent PIN first');
  const locked = fromSql(account.pin_locked_until);
  if (locked && locked > new Date()) throw lockedError(locked);

  if (await bcrypt.compare(String(pin), account.parent_pin_hash)) {
    if (account.pin_failed_attempts) await query('UPDATE accounts SET pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = ?', [account.id]);
    return;
  }
  const fails = account.pin_failed_attempts + 1;
  if (fails >= MAX_FAILS) {
    const until = addMinutes(new Date(), LOCK_MINUTES);
    await query('UPDATE accounts SET pin_failed_attempts = 0, pin_locked_until = ? WHERE id = ?', [toSql(until), account.id]);
    throw lockedError(until);
  }
  await query('UPDATE accounts SET pin_failed_attempts = ? WHERE id = ?', [fails, account.id]);
  throw new ApiError(401, 'PIN_INCORRECT', 'Incorrect PIN', { attemptsLeft: MAX_FAILS - fails });
}

/** Store a new PIN (bcrypt) and clear any lock. Sessions are untouched: the parent stays logged in. */
async function setPin(accountId, pin) {
  await query('UPDATE accounts SET parent_pin_hash = ?, pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = ?',
    [await bcrypt.hash(pin, config.bcryptRounds), accountId]);
}

module.exports = { verifyPin, setPin, MAX_FAILS, LOCK_MINUTES };
