const jwt = require('jsonwebtoken');
const config = require('../config');
const { query } = require('../db');
const { unauthorized, forbidden } = require('../utils/errors');

/** Short-lived tokens used between admin login steps (scope: totp_setup | totp_verify). */
const signStepToken = (admin, scope) =>
  jwt.sign({ scope, tv: admin.token_version }, config.adminJwtSecret, { subject: String(admin.id), expiresIn: '10m', audience: 'admin-step' });

const signAdminToken = (admin) =>
  jwt.sign({ scope: 'admin', role: admin.role, tv: admin.token_version }, config.adminJwtSecret,
    { subject: String(admin.id), expiresIn: config.adminTokenTtl, audience: 'admin' });

async function loadAdmin(token, audience, scope) {
  let payload;
  try { payload = jwt.verify(token, config.adminJwtSecret, { audience }); } catch { throw unauthorized('TOKEN_INVALID', 'Session expired or invalid'); }
  if (payload.scope !== scope) throw unauthorized('TOKEN_INVALID', 'Wrong token type');
  const admin = (await query('SELECT * FROM admins WHERE id = ?', [payload.sub]))[0];
  if (!admin || !admin.is_active || admin.token_version !== payload.tv) throw unauthorized('TOKEN_REVOKED', 'Session is no longer valid');
  return admin;
}

const bearer = (req) => {
  const m = (req.get('authorization') || '').match(/^Bearer (.+)$/i);
  if (!m) throw unauthorized();
  return m[1];
};

/** Fully authenticated admin (password + 2FA completed). */
async function requireAdmin(req, _res, next) {
  req.admin = await loadAdmin(bearer(req), 'admin', 'admin');
  next();
}

/** Mid-login admin holding a step token of the given scope. */
const requireStep = (scope) => async (req, _res, next) => {
  req.admin = await loadAdmin(bearer(req), 'admin-step', scope);
  next();
};

/** requireRole('full_admin') or requireRole('full_admin','content_editor') */
const requireRole = (...roles) => (req, _res, next) => {
  if (!roles.includes(req.admin.role)) throw forbidden('ROLE_FORBIDDEN', 'Your admin role cannot do this');
  next();
};

module.exports = { signStepToken, signAdminToken, requireAdmin, requireStep, requireRole };
