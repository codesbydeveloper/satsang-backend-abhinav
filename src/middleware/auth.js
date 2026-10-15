const { query } = require('../db');
const { verifyAccessToken } = require('../utils/tokens');
const { unauthorized, forbidden } = require('../utils/errors');

/** Requires a valid app access token. Sets req.account and req.profileId (may be null for a parent in parent mode). */
async function requireAuth(req, _res, next) {
  const header = req.get('authorization') || '';
  const m = header.match(/^Bearer (.+)$/i);
  if (!m) throw unauthorized();
  let payload;
  try { payload = verifyAccessToken(m[1]); } catch { throw unauthorized('TOKEN_INVALID', 'Session expired or invalid'); }

  const rows = await query('SELECT * FROM accounts WHERE id = ?', [payload.sub]);
  const account = rows[0];
  if (!account || account.token_version !== payload.tv) throw unauthorized('TOKEN_REVOKED', 'Session is no longer valid. Please log in again.');
  if (!account.email_verified_at) throw forbidden('EMAIL_NOT_VERIFIED', 'Please verify your email first');

  // the device session must still be active (logout / password change revoke it)
  const sess = await query('SELECT profile_id FROM refresh_tokens WHERE session_id = ? AND account_id = ? AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP() ORDER BY id DESC LIMIT 1',
    [payload.sid || '', account.id]);
  if (!sess.length) throw unauthorized('SESSION_ENDED', 'You have been logged out. Please log in again.');

  req.account = account;
  req.sessionId = payload.sid;
  req.profileId = sess[0].profile_id || null;   // the session row is the source of truth for the active profile
  next();
}

const requireParent = (req, _res, next) => {
  if (req.account.account_type !== 'parent') throw forbidden('PARENT_ONLY', 'Only parent accounts can do this');
  next();
};

module.exports = { requireAuth, requireParent };
