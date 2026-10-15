const bcrypt = require('bcryptjs');
const { query } = require('../db');
const { toSql, addMinutes, fromSql } = require('./time');
const { tooMany, unauthorized, conflict } = require('./errors');

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;

/** Verify the Parent PIN with brute-force protection. Throws if wrong, locked, or not set. */
async function verifyPin(account, pin) {
  if (!account.parent_pin_hash) throw conflict('PIN_NOT_SET', 'Create a Parent PIN first');
  const locked = fromSql(account.pin_locked_until);
  if (locked && locked > new Date()) throw tooMany('PIN_LOCKED', 'Too many wrong PIN attempts. Try again in a few minutes, or reset the PIN with your password.');

  if (await bcrypt.compare(String(pin), account.parent_pin_hash)) {
    if (account.pin_failed_attempts) await query('UPDATE accounts SET pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = ?', [account.id]);
    return;
  }
  const fails = account.pin_failed_attempts + 1;
  if (fails >= MAX_FAILS) {
    await query('UPDATE accounts SET pin_failed_attempts = 0, pin_locked_until = ? WHERE id = ?', [toSql(addMinutes(new Date(), LOCK_MINUTES)), account.id]);
    throw tooMany('PIN_LOCKED', 'Too many wrong PIN attempts. Try again in 15 minutes, or reset the PIN with your password.');
  }
  await query('UPDATE accounts SET pin_failed_attempts = ? WHERE id = ?', [fails, account.id]);
  throw unauthorized('PIN_INCORRECT', 'Incorrect PIN');
}

module.exports = { verifyPin };
