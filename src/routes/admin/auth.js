const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const config = require('../../config');
const { query } = require('../../db');
const validate = require('../../middleware/validate');
const { adminLimiter, adminOtpLimiter, adminResendLimiter, adminRefreshLimiter, adminInviteLimiter } = require('../../middleware/rateLimit');
const {
  findTrustedDevice, trustDevice, deviceView, labelOf, issueRefreshToken, rotateRefreshToken, revokeAllRefreshTokens,
  queueLoginAlert, endAdminAccess,
} = require('../../utils/adminSessions');
const { CHALLENGE_MINUTES, signChallengeToken, signAdminToken, loadChallenge, requireAdmin } = require('../../middleware/adminAuth');
const S = require('../../utils/schemas');
const { ApiError, unauthorized, tooMany, notFound } = require('../../utils/errors');
const { findInvite } = require('../../utils/adminInvites');
const { audit } = require('../../utils/audit');
const { sha256, randomCode } = require('../../utils/tokens');
const { sendAdminLoginCode } = require('../../utils/mailer');
const { toSql, addMinutes, fromSql } = require('../../utils/time');

const router = express.Router();
const MAX_FAILS = 5;           // password / code failures before the account locks
const LOCK_MIN = 15;
const CODE_MINUTES = 10;       // emailed login code lifetime
const MAX_CODE_TRIES = 5;      // wrong tries per code, then the admin must log in again
const RESEND_SECONDS = 60;     // at most one resend per minute
const MAX_RESENDS = 5;         // per login
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', config.bcryptRounds);

const adminView = (a) => ({ id: a.id, email: a.email, name: a.name, role: a.role });

async function registerFailure(req, admin, why) {
  const fails = admin.failed_attempts + 1;
  if (fails >= MAX_FAILS) {
    await query('UPDATE admins SET failed_attempts = 0, locked_until = ? WHERE id = ?', [toSql(addMinutes(new Date(), LOCK_MIN)), admin.id]);
    await audit(req, 'admin.locked', { admin, entityType: 'admin', entityId: admin.id, details: { why } });
  } else {
    await query('UPDATE admins SET failed_attempts = ? WHERE id = ?', [fails, admin.id]);
  }
  if (why === 'bad_password') await audit(req, 'admin.login_failed', { admin, entityType: 'admin', entityId: admin.id, details: { why } });
}

function assertNotLocked(admin) {
  const locked = fromSql(admin.locked_until);
  if (locked && locked > new Date()) throw tooMany('ADMIN_LOCKED', 'Too many failed attempts. Try again in 15 minutes.');
}

/** Email the code. The code itself is never logged, stored in plain text or returned. */
async function emailCode(req, admin, code, resend) {
  try {
    await sendAdminLoginCode(admin.email, code);
  } catch (err) {
    console.error('ADMIN LOGIN CODE EMAIL FAILED', err.message);
    throw new ApiError(503, 'EMAIL_FAILED', 'We could not send the login code. Please try again.');
  }
  await audit(req, 'admin.login_code_sent', { admin, entityType: 'admin', entityId: admin.id, details: resend ? { resend: true } : null });
}

/** The login challenge row for a challenge token; refuses used / locked ones. */
async function openChallenge(challengeToken) {
  const { admin, challengeId, rememberMe } = await loadChallenge(challengeToken);
  const row = (await query('SELECT * FROM admin_login_codes WHERE id = ? AND admin_id = ?', [challengeId, admin.id]))[0];
  if (!row || row.used_at) throw unauthorized('CHALLENGE_INVALID', 'This login has expired. Please log in again.');
  if (row.attempts >= MAX_CODE_TRIES) throw tooMany('OTP_LOCKED', 'Too many wrong codes. Please log in again.');
  return { admin, row, rememberMe };
}

/**
 * A new sign-in has passed every check (password + code, or password on a trusted device): reset the failure count,
 * audit it, optionally start a 30-day "Remember me" session, alert the Full Admins in the background, and reply.
 * Refreshing a token never comes here (so it never alerts).
 */
async function completeLogin(req, res, admin, { method, rememberMe, deviceLabel: label, extra = {} }) {
  await query('UPDATE admins SET failed_attempts = 0, locked_until = NULL, last_login_at = UTC_TIMESTAMP() WHERE id = ?', [admin.id]);
  await audit(req, 'admin.login_success', { admin, entityType: 'admin', entityId: admin.id, details: { method } });
  const refresh = rememberMe ? await issueRefreshToken(admin) : { refreshToken: null, refreshExpiresAt: null };
  queueLoginAlert(admin, label);
  res.json({ step: 'done', token: signAdminToken(admin), admin: adminView(admin), rememberMe: !!rememberMe, ...refresh, ...extra });
}

// Step 1: email + password. From a trusted device (deviceToken) → logged in at once (step "done"). Otherwise emails a
// 6-digit code and returns a single-use challenge token (step "email_otp", no admin token yet).
router.post('/login', adminLimiter, validate(z.object({
  email: S.email, password: z.string().min(1).max(200),
  deviceToken: z.string().max(200).optional(), rememberMe: z.boolean().optional().default(false),
})), async (req, res) => {
  const admin = (await query('SELECT * FROM admins WHERE email = ?', [req.body.email]))[0];
  // invited admins have no password yet: compare against a dummy so the timing and the error stay the same
  const ok = await bcrypt.compare(req.body.password, admin && admin.password_hash ? admin.password_hash : DUMMY_HASH);
  if (!admin || !admin.is_active) throw unauthorized('INVALID_CREDENTIALS', 'Email or password is incorrect');
  assertNotLocked(admin);
  if (!ok) { await registerFailure(req, admin, 'bad_password'); throw unauthorized('INVALID_CREDENTIALS', 'Email or password is incorrect'); }

  const { deviceToken, rememberMe } = req.body;
  const device = await findTrustedDevice(admin.id, deviceToken);
  if (device) {
    await query('UPDATE admin_trusted_devices SET last_used_at = UTC_TIMESTAMP() WHERE id = ?', [device.id]);
    await query('UPDATE admin_login_codes SET used_at = UTC_TIMESTAMP() WHERE admin_id = ? AND used_at IS NULL', [admin.id]);
    return completeLogin(req, res, admin, { method: 'trusted_device', rememberMe, deviceLabel: device.label, extra: { device: deviceView(device) } });
  }

  // A new login cancels this admin's earlier unfinished ones; rows older than a day are removed.
  await query('UPDATE admin_login_codes SET used_at = UTC_TIMESTAMP() WHERE admin_id = ? AND used_at IS NULL', [admin.id]);
  await query('DELETE FROM admin_login_codes WHERE admin_id = ? AND created_at < UTC_TIMESTAMP() - INTERVAL 1 DAY', [admin.id]);
  const code = randomCode();
  const r = await query('INSERT INTO admin_login_codes (admin_id, code_hash, expires_at, last_sent_at) VALUES (?,?,?, UTC_TIMESTAMP())',
    [admin.id, sha256(code), toSql(addMinutes(new Date(), CODE_MINUTES))]);
  await emailCode(req, admin, code, false);
  res.json({
    step: 'email_otp', challengeToken: signChallengeToken(admin, r.insertId, rememberMe),
    expiresInSeconds: CHALLENGE_MINUTES * 60, resendAfterSeconds: RESEND_SECONDS,
    // a deviceToken was sent but is not (or no longer) trusted for this admin: the panel can forget it
    ...(deviceToken ? { deviceTokenInvalid: true } : {}),
  });
});

// Step 2: the emailed code. Correct → the admin token; the challenge is then used up. trustDevice: true → this browser
// becomes a trusted device and a new deviceToken is returned (once).
router.post('/verify-otp', adminOtpLimiter, validate(z.object({
  challengeToken: z.string().min(1).max(2000), code: S.code, trustDevice: z.boolean().optional().default(false),
})), async (req, res) => {
  const { admin, row, rememberMe } = await openChallenge(req.body.challengeToken);
  assertNotLocked(admin);
  if (fromSql(row.expires_at) <= new Date()) throw unauthorized('OTP_EXPIRED', 'This code has expired. Request a new code or log in again.');

  if (row.code_hash !== sha256(req.body.code)) {
    const attemptsLeft = MAX_CODE_TRIES - (row.attempts + 1);
    await query('UPDATE admin_login_codes SET attempts = attempts + 1 WHERE id = ?', [row.id]);
    await registerFailure(req, admin, 'bad_code');
    await audit(req, 'admin.login_code_failed', { admin, entityType: 'admin', entityId: admin.id, details: { attemptsLeft } });
    if (attemptsLeft <= 0) throw tooMany('OTP_LOCKED', 'Too many wrong codes. Please log in again.');
    throw new ApiError(401, 'OTP_INVALID', 'That code is incorrect.', { attemptsLeft });
  }

  // Single use: only the request that flips used_at wins (protects against two parallel verifies).
  const used = await query('UPDATE admin_login_codes SET used_at = UTC_TIMESTAMP() WHERE id = ? AND used_at IS NULL', [row.id]);
  if (!used.affectedRows) throw unauthorized('CHALLENGE_INVALID', 'This login has expired. Please log in again.');
  let extra = {};
  if (req.body.trustDevice) {
    const t = await trustDevice(req, admin);
    extra = { deviceToken: t.deviceToken, device: deviceView(t.device) };
  }
  return completeLogin(req, res, admin, { method: 'otp', rememberMe, deviceLabel: labelOf(req), extra });
});

// "Remember me": a new admin token for a refresh token. The refresh token rotates (the old one stops working) and its
// 30 days restart. Not a new sign-in: no audit entry, no login alert.
router.post('/refresh', adminRefreshLimiter, validate(z.object({ refreshToken: z.string().min(1).max(200) })), async (req, res) => {
  const r = await rotateRefreshToken(req.body.refreshToken);
  if (!r) throw unauthorized('REFRESH_INVALID', 'Your session has ended. Please log in again.');
  res.json({ token: signAdminToken(r.admin), admin: adminView(r.admin), refreshToken: r.refreshToken, refreshExpiresAt: r.refreshExpiresAt });
});

// A new code for the same login (the previous code stops working). Once per minute, at most 5 times per login.
router.post('/resend-otp', adminResendLimiter, validate(z.object({ challengeToken: z.string().min(1).max(2000) })), async (req, res) => {
  const { admin, row } = await openChallenge(req.body.challengeToken);
  assertNotLocked(admin);
  if (row.resend_count >= MAX_RESENDS) throw tooMany('RESEND_LIMIT', 'Too many new codes for this login. Please log in again.');
  const waited = (Date.now() - fromSql(row.last_sent_at).getTime()) / 1000;
  if (waited < RESEND_SECONDS) {
    const retryAfterSeconds = Math.ceil(RESEND_SECONDS - waited);
    throw new ApiError(429, 'RESEND_TOO_SOON', `Please wait ${retryAfterSeconds} seconds before asking for a new code.`, { retryAfterSeconds });
  }
  const code = randomCode();
  await query(
    'UPDATE admin_login_codes SET code_hash = ?, expires_at = ?, attempts = 0, resend_count = resend_count + 1, last_sent_at = UTC_TIMESTAMP() WHERE id = ? AND used_at IS NULL',
    [sha256(code), toSql(addMinutes(new Date(), CODE_MINUTES)), row.id]);
  await emailCode(req, admin, code, true);
  res.json({ sent: true, expiresInSeconds: CODE_MINUTES * 60, resendAfterSeconds: RESEND_SECONDS, resendsLeft: MAX_RESENDS - (row.resend_count + 1) });
});

// Public: what the accept-invite page shows before the new admin chooses a password.
router.get('/invite/:token', adminInviteLimiter, async (req, res) => {
  const a = await findInvite(req.params.token);
  res.json({ email: a.email, name: a.name, role: a.role });
});

// Public: accept an invite by choosing a password. The admin becomes active; they then log in normally (password + email code).
router.post('/accept-invite', adminInviteLimiter, validate(z.object({ token: z.string().min(1).max(200), password: z.string().min(12).max(72) })), async (req, res) => {
  const a = await findInvite(req.body.token);
  const hash = await bcrypt.hash(req.body.password, config.bcryptRounds);
  // Only the request that still matches the token wins (the link works once).
  const r = await query(
    `UPDATE admins SET password_hash = ?, is_active = 1, invite_token_hash = NULL, invite_expires_at = NULL, activated_at = UTC_TIMESTAMP(),
       failed_attempts = 0, locked_until = NULL WHERE id = ? AND invite_token_hash = ? AND password_hash IS NULL`,
    [hash, a.id, a.invite_token_hash]);
  if (!r.affectedRows) throw notFound('INVITE_INVALID', 'This invite link is not valid. Ask a Full Admin to send a new one.');
  await audit(req, 'admin.invite_accepted', { admin: a, entityType: 'admin', entityId: a.id });
  res.json({ ok: true, email: a.email, message: 'Your password is set. You can now log in.' });
});

router.get('/me', requireAdmin, (req, res) => res.json({ admin: adminView(req.admin) }));

router.post('/logout', requireAdmin, async (req, res) => {
  // Ends this admin's sessions and revokes their refresh tokens. Trusted devices stay trusted.
  await query('UPDATE admins SET token_version = token_version + 1 WHERE id = ?', [req.admin.id]);
  await revokeAllRefreshTokens(req.admin.id);
  await audit(req, 'admin.logout', { entityType: 'admin', entityId: req.admin.id });
  res.json({ ok: true });
});

router.post('/change-password', requireAdmin, validate(z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(12).max(72) })), async (req, res) => {
  if (!(await bcrypt.compare(req.body.currentPassword, req.admin.password_hash))) throw unauthorized('INVALID_CREDENTIALS', 'Current password is incorrect');
  await query('UPDATE admins SET password_hash = ?, token_version = token_version + 1 WHERE id = ?', [await bcrypt.hash(req.body.newPassword, config.bcryptRounds), req.admin.id]);
  await endAdminAccess(req, req.admin.id, 'password_changed');
  await audit(req, 'admin.password_changed', { entityType: 'admin', entityId: req.admin.id });
  res.json({ ok: true, message: 'Password changed. Please log in again.' });
});

module.exports = router;
