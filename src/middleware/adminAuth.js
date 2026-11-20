const jwt = require('jsonwebtoken');
const config = require('../config');
const { query } = require('../db');
const { unauthorized, forbidden } = require('../utils/errors');

/**
 * Short-lived login challenge token (after the password, before the emailed code). cid = admin_login_codes.id;
 * that row's used_at makes it single use. Only accepted by /admin/auth/verify-otp and /admin/auth/resend-otp.
 */
const CHALLENGE_MINUTES = 10;
const signChallengeToken = (admin, challengeId) =>
  jwt.sign({ scope: 'login_otp', cid: challengeId, tv: admin.token_version }, config.adminJwtSecret,
    { subject: String(admin.id), expiresIn: `${CHALLENGE_MINUTES}m`, audience: 'admin-challenge' });

const signAdminToken = (admin) =>
  jwt.sign({ scope: 'admin', role: admin.role, tv: admin.token_version }, config.adminJwtSecret,
    { subject: String(admin.id), expiresIn: config.adminTokenTtl, audience: 'admin' });

async function loadAdmin(token, audience, scope, invalidCode = 'TOKEN_INVALID', invalidMessage = 'Session expired or invalid') {
  let payload;
  try { payload = jwt.verify(token, config.adminJwtSecret, { audience }); } catch { throw unauthorized(invalidCode, invalidMessage); }
  if (payload.scope !== scope) throw unauthorized(invalidCode, 'Wrong token type');
  const admin = (await query('SELECT * FROM admins WHERE id = ?', [payload.sub]))[0];
  if (!admin || !admin.is_active || admin.token_version !== payload.tv) throw unauthorized('TOKEN_REVOKED', 'Session is no longer valid');
  return { admin, payload };
}

/** Admin + challenge id from a login challenge token (sent in the request body as challengeToken). */
async function loadChallenge(challengeToken) {
  const { admin, payload } = await loadAdmin(String(challengeToken || ''), 'admin-challenge', 'login_otp',
    'CHALLENGE_INVALID', 'This login has expired. Please log in again.');
  return { admin, challengeId: payload.cid };
}

const bearer = (req) => {
  const m = (req.get('authorization') || '').match(/^Bearer (.+)$/i);
  if (!m) throw unauthorized();
  return m[1];
};

/** Fully authenticated admin (password + emailed login code completed). */
async function requireAdmin(req, _res, next) {
  req.admin = (await loadAdmin(bearer(req), 'admin', 'admin')).admin;
  next();
}

/** requireRole('full_admin') or requireRole('full_admin','content_editor') */
const requireRole = (...roles) => (req, _res, next) => {
  if (!roles.includes(req.admin.role)) throw forbidden('ROLE_FORBIDDEN', 'Your admin role cannot do this');
  next();
};

module.exports = { CHALLENGE_MINUTES, signChallengeToken, signAdminToken, loadChallenge, requireAdmin, requireRole };
