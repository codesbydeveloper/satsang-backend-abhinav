const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const config = require('../config');
const { query, tx } = require('../db');
const validate = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const { authLimiter, codeLimiter } = require('../middleware/rateLimit');
const S = require('../utils/schemas');
const { badRequest, unauthorized, forbidden, conflict } = require('../utils/errors');
const { issueCode, consumeCode } = require('../utils/emailCodes');
const { sendVerificationCode, sendPasswordResetCode } = require('../utils/mailer');
const { revokeAllRefreshTokens, sha256 } = require('../utils/tokens');
const { ageOn, ageGroupForDob } = require('../utils/ageGroup');
const { checkUsername, lowerKey } = require('../utils/usernameFilter');
const { startSession, createRefresh, buildAuthResponse } = require('../utils/session');
const { loadProfiles } = require('../utils/profiles');
const { toSql } = require('../utils/time');

const router = express.Router();

// Used so a login for an unknown email takes the same time as a wrong password.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', config.bcryptRounds);

const registerSchema = z.object({
  email: S.email,
  password: S.password,
  accountType: z.enum(['adult', 'parent']),
  phone: S.phone.optional(),
  language: S.language.default('en'),
  acceptPrivacyPolicy: z.literal(true, { error: 'You must accept the privacy policy' }),
  confirmAdult: z.boolean().optional(),                       // parents confirm they are 18+
  profile: z.object({                                         // adult accounts only: their own playable profile
    username: S.username, avatarId: S.avatarId, dob: S.dob, mode: S.mode.optional(),
  }).optional(),
}).superRefine((v, ctx) => {
  if (v.accountType === 'adult' && !v.profile) ctx.addIssue({ code: 'custom', path: ['profile'], message: 'Profile (username, avatar, date of birth) is required' });
  if (v.accountType === 'parent' && v.profile) ctx.addIssue({ code: 'custom', path: ['profile'], message: 'Parent accounts add child profiles after signing up' });
  if (v.accountType === 'parent' && v.confirmAdult !== true) ctx.addIssue({ code: 'custom', path: ['confirmAdult'], message: 'Parents must confirm they are 18 or older' });
});

router.post('/register', authLimiter, validate(registerSchema), async (req, res) => {
  const b = req.body;
  if (b.profile) {
    // independent users must be old enough to hold their own account; younger children use a parent account
    if (ageOn(b.profile.dob) < config.parentalConsentAge) {
      throw badRequest('PARENT_ACCOUNT_REQUIRED', `Users under ${config.parentalConsentAge} need a parent account to create their profile.`);
    }
    const u = await checkUsername(b.profile.username);
    if (!u.ok) throw badRequest('USERNAME_' + u.reason, 'That username cannot be used');
  }
  if ((await query('SELECT 1 FROM accounts WHERE email = ?', [b.email])).length) throw conflict('EMAIL_TAKEN', 'An account with this email already exists');

  const hash = await bcrypt.hash(b.password, config.bcryptRounds);
  const accountId = await tx(async (c) => {
    const r = await c.query(
      `INSERT INTO accounts (email, password_hash, account_type, phone, preferred_language, privacy_policy_version, consent_accepted_at)
       VALUES (?,?,?,?,?,?,UTC_TIMESTAMP())`,
      [b.email, hash, b.accountType, b.phone || null, b.language, config.privacyPolicyVersion]);
    if (b.profile) {
      const p = b.profile;
      await c.query(
        `INSERT INTO profiles (account_id, username, username_lower, avatar_id, dob, age_group, is_child, language, mode)
         VALUES (?,?,?,?,?,?,0,?,?)`,
        [r.insertId, p.username.normalize('NFC'), lowerKey(p.username), p.avatarId, p.dob, ageGroupForDob(p.dob), b.language, p.mode || null]);
    }
    return r.insertId;
  });

  await sendVerificationCode(b.email, await issueCode(accountId, 'verify_email'));
  res.status(201).json({ needsEmailVerification: true, email: b.email });
});

router.post('/verify-email', authLimiter, validate(z.object({ email: S.email, code: S.code })), async (req, res) => {
  const account = (await query('SELECT * FROM accounts WHERE email = ?', [req.body.email]))[0];
  if (!account) throw badRequest('CODE_INVALID', 'That code is invalid or has expired. Request a new one.');
  await consumeCode(account.id, 'verify_email', req.body.code);
  await query('UPDATE accounts SET email_verified_at = COALESCE(email_verified_at, UTC_TIMESTAMP()) WHERE id = ?', [account.id]);
  account.email_verified_at = account.email_verified_at || toSql();
  res.json(await startSession(account));
});

router.post('/resend-code', codeLimiter, validate(z.object({ email: S.email })), async (req, res) => {
  const account = (await query('SELECT * FROM accounts WHERE email = ?', [req.body.email]))[0];
  if (account && !account.email_verified_at) await sendVerificationCode(account.email, await issueCode(account.id, 'verify_email'));
  res.json({ ok: true }); // same answer whether or not the email exists
});

router.post('/login', authLimiter, validate(z.object({ email: S.email, password: z.string().min(1).max(200) })), async (req, res) => {
  const account = (await query('SELECT * FROM accounts WHERE email = ?', [req.body.email]))[0];
  const ok = await bcrypt.compare(req.body.password, account ? account.password_hash : DUMMY_HASH);
  if (!account || !ok) throw unauthorized('INVALID_CREDENTIALS', 'Email or password is incorrect');
  if (!account.email_verified_at) throw forbidden('EMAIL_NOT_VERIFIED', 'Please verify your email first');
  res.json(await startSession(account));
});

router.post('/refresh', authLimiter, validate(z.object({ refreshToken: z.string().min(20).max(200) })), async (req, res) => {
  const row = (await query('SELECT * FROM refresh_tokens WHERE token_hash = ?', [sha256(req.body.refreshToken)]))[0];
  if (!row || row.revoked_at || row.expires_at <= toSql()) throw unauthorized('REFRESH_INVALID', 'Please log in again');
  const account = (await query('SELECT * FROM accounts WHERE id = ?', [row.account_id]))[0];
  if (!account) throw unauthorized('REFRESH_INVALID', 'Please log in again');

  // rotate: the old token dies, the session (and its active profile) continues
  await query('UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP() WHERE id = ?', [row.id]);
  const { raw } = await createRefresh(account.id, { sessionId: row.session_id, profileId: row.profile_id });
  const profiles = await loadProfiles(account.id);
  res.json(buildAuthResponse(account, profiles, row.profile_id, raw, row.session_id));
});

router.post('/logout', requireAuth, async (req, res) => {
  await query('UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP() WHERE session_id = ? AND revoked_at IS NULL', [req.sessionId]);
  res.json({ ok: true });
});

router.post('/forgot-password', codeLimiter, validate(z.object({ email: S.email })), async (req, res) => {
  const account = (await query('SELECT * FROM accounts WHERE email = ?', [req.body.email]))[0];
  if (account && account.email_verified_at) await sendPasswordResetCode(account.email, await issueCode(account.id, 'reset_password'));
  res.json({ ok: true }); // never reveals whether the email is registered
});

router.post('/reset-password', authLimiter,
  validate(z.object({ email: S.email, code: S.code, newPassword: S.password })), async (req, res) => {
    const account = (await query('SELECT * FROM accounts WHERE email = ?', [req.body.email]))[0];
    if (!account) throw badRequest('CODE_INVALID', 'That code is invalid or has expired. Request a new one.');
    await consumeCode(account.id, 'reset_password', req.body.code);
    const hash = await bcrypt.hash(req.body.newPassword, config.bcryptRounds);
    await tx(async (c) => {
      await c.query('UPDATE accounts SET password_hash = ?, token_version = token_version + 1 WHERE id = ?', [hash, account.id]);
      await revokeAllRefreshTokens(account.id, c);   // logs out every device
    });
    res.json({ ok: true });
  });

module.exports = router;
