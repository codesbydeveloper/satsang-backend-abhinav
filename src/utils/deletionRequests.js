const { query } = require('../db');

const view = (r) => ({ requested: true, requestId: r.id, status: r.status, requestedAt: r.requested_at });

/**
 * Record that the account owner asked for deletion. Idempotent: if a request is already pending,
 * that one is returned instead of creating a second.
 * @param {'app'|'web'} source
 */
async function requestDeletion(account, source) {
  try {
    const r = await query('INSERT INTO account_deletion_requests (account_id, account_type, source) VALUES (?,?,?)', [account.id, account.account_type, source]);
    return view((await query('SELECT * FROM account_deletion_requests WHERE id = ?', [r.insertId]))[0]);
  } catch (err) {
    if (err.code !== 'ER_DUP_ENTRY') throw err;
    return view((await query("SELECT * FROM account_deletion_requests WHERE account_id = ? AND status = 'pending'", [account.id]))[0]);
  }
}

module.exports = { requestDeletion };
