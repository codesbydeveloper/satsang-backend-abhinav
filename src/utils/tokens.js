const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { query } = require('../db');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomToken = () => crypto.randomBytes(48).toString('base64url');
const randomCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

/** Access token. pid = the active playable profile (null while a parent is in "parent mode"). */
function signAccessToken(account, profileId = null, sessionId = null) {
  return jwt.sign({ tv: account.token_version, pid: profileId, sid: sessionId }, config.jwtSecret, {
    subject: String(account.id), expiresIn: config.accessTokenTtl, audience: 'app',
  });
}

function verifyAccessToken(token) {
  return jwt.verify(token, config.jwtSecret, { audience: 'app' });
}

async function revokeAllRefreshTokens(accountId, conn = { query }) {
  await conn.query('UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP() WHERE account_id = ? AND revoked_at IS NULL', [accountId]);
}

module.exports = { sha256, randomToken, randomCode, signAccessToken, verifyAccessToken, revokeAllRefreshTokens };
