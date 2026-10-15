const express = require('express');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const { authenticator } = require('otplib');
const { z } = require('zod');
const config = require('../../config');
const { query } = require('../../db');
const validate = require('../../middleware/validate');
const { adminLimiter } = require('../../middleware/rateLimit');
const { signStepToken, signAdminToken, requireAdmin, requireStep } = require('../../middleware/adminAuth');
const S = require('../../utils/schemas');
const { unauthorized, tooMany, badRequest } = require('../../utils/errors');
const { encrypt, decrypt } = require('../../utils/crypto');
const { audit } = require('../../utils/audit');
const { toSql, addMinutes, fromSql } = require('../../utils/time');

authenticator.options = { window: 1 };   // accept the previous/next 30s code to allow small clock drift

const router = express.Router();
const MAX_FAILS = 5;
const LOCK_MIN = 15;
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', config.bcryptRounds);

const adminView = (a) => ({ id: a.id, email: a.email, name: a.name, role: a.role, totpEnabled: !!a.totp_enabled });

async function registerFailure(req, admin, why) {
  const fails = admin.failed_attempts + 1;
  if (fails >= MAX_FAILS) {
    await query('UPDATE admins SET failed_attempts = 0, locked_until = ? WHERE id = ?', [toSql(addMinutes(new Date(), LOCK_MIN)), admin.id]);
    await audit(req, 'admin.locked', { admin, entityType: 'admin', entityId: admin.id, details: { why } });
  } else {
    await query('UPDATE admins SET failed_attempts = ? WHERE id = ?', [fails, admin.id]);
  }
  await audit(req, 'admin.login_failed', { admin, entityType: 'admin', entityId: admin.id, details: { why } });
}

function assertNotLocked(admin) {
  const locked = fromSql(admin.locked_until);
  if (locked && locked > new Date()) throw tooMany('ADMIN_LOCKED', 'Too many failed attempts. Try again in 15 minutes.');
}

async function finishLogin(req, admin) {
  await query('UPDATE admins SET failed_attempts = 0, locked_until = NULL, last_login_at = UTC_TIMESTAMP() WHERE id = ?', [admin.id]);
  await audit(req, 'admin.login', { admin, entityType: 'admin', entityId: admin.id });
  return { token: signAdminToken(admin), admin: adminView(admin) };
}

// Step 1: email + password. The result tells the panel which 2FA step comes next.
router.post('/login', adminLimiter, validate(z.object({ email: S.email, password: z.string().min(1).max(200) })), async (req, res) => {
  const admin = (await query('SELECT * FROM admins WHERE email = ?', [req.body.email]))[0];
  const ok = await bcrypt.compare(req.body.password, admin ? admin.password_hash : DUMMY_HASH);
  if (!admin || !admin.is_active) throw unauthorized('INVALID_CREDENTIALS', 'Email or password is incorrect');
  assertNotLocked(admin);
  if (!ok) { await registerFailure(req, admin, 'bad_password'); throw unauthorized('INVALID_CREDENTIALS', 'Email or password is incorrect'); }

  const scope = admin.totp_enabled ? 'totp_verify' : 'totp_setup';
  res.json({ step: scope, stepToken: signStepToken(admin, scope) });
});

// Step 2a (first login): start authenticator enrolment. Returns the secret + QR code to scan.
router.post('/totp/setup', adminLimiter, requireStep('totp_setup'), async (req, res) => {
  const secret = authenticator.generateSecret();
  await query('UPDATE admins SET totp_secret_enc = ?, totp_enabled = 0 WHERE id = ?', [encrypt(secret), req.admin.id]);
  const otpauthUrl = authenticator.keyuri(req.admin.email, 'Satsang Spark Admin', secret);
  res.json({ secret, otpauthUrl, qrDataUrl: await QRCode.toDataURL(otpauthUrl) });
});

// Step 2b: confirm enrolment with the first code; completes the login.
router.post('/totp/enable', adminLimiter, requireStep('totp_setup'), validate(z.object({ code: S.code })), async (req, res) => {
  const admin = req.admin;
  assertNotLocked(admin);
  if (!admin.totp_secret_enc) throw badRequest('TOTP_NOT_STARTED', 'Start 2FA setup first');
  if (!authenticator.check(req.body.code, decrypt(admin.totp_secret_enc))) {
    await registerFailure(req, admin, 'bad_totp');
    throw unauthorized('TOTP_INVALID', 'That code is incorrect');
  }
  await query('UPDATE admins SET totp_enabled = 1 WHERE id = ?', [admin.id]);
  admin.totp_enabled = 1;
  await audit(req, 'admin.totp_enabled', { entityType: 'admin', entityId: admin.id });
  res.json(await finishLogin(req, admin));
});

// Step 2 (normal logins): verify the 6-digit authenticator code.
router.post('/totp/verify', adminLimiter, requireStep('totp_verify'), validate(z.object({ code: S.code })), async (req, res) => {
  const admin = req.admin;
  assertNotLocked(admin);
  if (!authenticator.check(req.body.code, decrypt(admin.totp_secret_enc))) {
    await registerFailure(req, admin, 'bad_totp');
    throw unauthorized('TOTP_INVALID', 'That code is incorrect');
  }
  res.json(await finishLogin(req, admin));
});

router.get('/me', requireAdmin, (req, res) => res.json({ admin: adminView(req.admin) }));

router.post('/logout', requireAdmin, async (req, res) => {
  await query('UPDATE admins SET token_version = token_version + 1 WHERE id = ?', [req.admin.id]);
  await audit(req, 'admin.logout', { entityType: 'admin', entityId: req.admin.id });
  res.json({ ok: true });
});

router.post('/change-password', requireAdmin, validate(z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(12).max(72) })), async (req, res) => {
  if (!(await bcrypt.compare(req.body.currentPassword, req.admin.password_hash))) throw unauthorized('INVALID_CREDENTIALS', 'Current password is incorrect');
  await query('UPDATE admins SET password_hash = ?, token_version = token_version + 1 WHERE id = ?', [await bcrypt.hash(req.body.newPassword, config.bcryptRounds), req.admin.id]);
  await audit(req, 'admin.password_changed', { entityType: 'admin', entityId: req.admin.id });
  res.json({ ok: true, message: 'Password changed. Please log in again.' });
});

module.exports = router;
