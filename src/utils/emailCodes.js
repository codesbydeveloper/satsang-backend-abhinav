const { query } = require('../db');
const { sha256, randomCode } = require('./tokens');
const { toSql, addMinutes } = require('./time');
const { badRequest, tooMany } = require('./errors');

const CODE_MINUTES = 15;
const MAX_ATTEMPTS = 5;

/** Create a fresh 6-digit code (older unused codes for the same purpose are cancelled). Returns the raw code. */
async function issueCode(accountId, purpose) {
  await query('UPDATE email_codes SET consumed_at = UTC_TIMESTAMP() WHERE account_id = ? AND purpose = ? AND consumed_at IS NULL', [accountId, purpose]);
  const code = randomCode();
  await query('INSERT INTO email_codes (account_id, purpose, code_hash, expires_at) VALUES (?,?,?,?)',
    [accountId, purpose, sha256(code), toSql(addMinutes(new Date(), CODE_MINUTES))]);
  return code;
}

/** Check a code; consumes it on success. Throws a clear error on failure. */
async function consumeCode(accountId, purpose, code) {
  const row = (await query(
    'SELECT * FROM email_codes WHERE account_id = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > UTC_TIMESTAMP() ORDER BY id DESC LIMIT 1',
    [accountId, purpose]))[0];
  if (!row) throw badRequest('CODE_INVALID', 'That code is invalid or has expired. Request a new one.');
  if (row.attempts >= MAX_ATTEMPTS) throw tooMany('CODE_LOCKED', 'Too many wrong codes. Request a new one.');
  if (row.code_hash !== sha256(String(code))) {
    await query('UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?', [row.id]);
    throw badRequest('CODE_INVALID', 'That code is incorrect.');
  }
  await query('UPDATE email_codes SET consumed_at = UTC_TIMESTAMP() WHERE id = ?', [row.id]);
}

module.exports = { issueCode, consumeCode };
