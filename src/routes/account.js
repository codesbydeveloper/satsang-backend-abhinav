const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const config = require('../config');
const { query, tx } = require('../db');
const validate = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const S = require('../utils/schemas');
const { unauthorized, badRequest, forbidden, conflict } = require('../utils/errors');
const { accountView, profileView, loadProfiles } = require('../utils/profiles');
const { revokeAllRefreshTokens, signAccessToken } = require('../utils/tokens');
const { startSession } = require('../utils/session');
const { ageOn, ageGroupForDob } = require('../utils/ageGroup');
const { checkUsername, lowerKey } = require('../utils/usernameFilter');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const profiles = await loadProfiles(req.account.id);
  res.json({ account: accountView(req.account), profiles: profiles.map((p) => profileView(p, { own: true })), activeProfileId: req.profileId });
});

router.patch('/', validate(z.object({ phone: S.phone.nullable().optional(), language: S.language.optional() })), async (req, res) => {
  const { phone, language } = req.body;
  if (phone !== undefined) await query('UPDATE accounts SET phone = ? WHERE id = ?', [phone, req.account.id]);
  if (language) await query('UPDATE accounts SET preferred_language = ? WHERE id = ?', [language, req.account.id]);
  const a = (await query('SELECT * FROM accounts WHERE id = ?', [req.account.id]))[0];
  res.json({ account: accountView(a) });
});

/**
 * Independent accounts create their own playable profile after verifying their email (Part 6 "Profile setup").
 * Uses the date of birth given at registration (then removes it from the account: it lives on the profile only),
 * and makes the new profile active on this device session.
 */
router.post('/profile', validate(z.object({ username: S.username, avatarId: S.avatarId, mode: S.mode.optional() })), async (req, res) => {
  const a = req.account;
  if (a.account_type !== 'adult') throw forbidden('INDEPENDENT_ONLY', 'Parent accounts add child profiles with POST /profiles');
  if ((await query('SELECT 1 FROM profiles WHERE account_id = ? LIMIT 1', [a.id])).length) throw conflict('PROFILE_EXISTS', 'This account already has a profile');
  if (!a.dob) throw badRequest('DOB_MISSING', 'This account has no date of birth on file');
  // checked at registration; checked again in case the consent age setting changed since
  if (ageOn(a.dob) < config.parentalConsentAge) throw badRequest('PARENT_ACCOUNT_REQUIRED', 'Please ask a parent to create a Parent account for you.');
  const u = await checkUsername(req.body.username);
  if (!u.ok) throw badRequest('USERNAME_' + u.reason, 'That username cannot be used');

  const { username, avatarId, mode } = req.body;
  const profileId = await tx(async (c) => {
    const r = await c.query(
      `INSERT INTO profiles (account_id, username, username_lower, avatar_id, dob, age_group, is_child, language, mode)
       VALUES (?,?,?,?,?,?,0,?,?)`,
      [a.id, username.normalize('NFC'), lowerKey(username), avatarId, a.dob, ageGroupForDob(a.dob), a.preferred_language, mode || null]);
    await c.query('UPDATE accounts SET dob = NULL WHERE id = ?', [a.id]);
    // this device session now plays as the new profile (refresh keeps it)
    await c.query('UPDATE refresh_tokens SET profile_id = ? WHERE session_id = ? AND account_id = ? AND revoked_at IS NULL', [r.insertId, req.sessionId, a.id]);
    return r.insertId;
  });
  const p = (await query('SELECT * FROM profiles WHERE id = ?', [profileId]))[0];
  res.status(201).json({
    accessToken: signAccessToken(a, profileId, req.sessionId),
    activeProfileId: profileId,
    profile: profileView(p, { own: true }),
  });
});

router.post('/change-password', validate(z.object({ currentPassword: z.string().min(1), newPassword: S.password })), async (req, res) => {
  if (!(await bcrypt.compare(req.body.currentPassword, req.account.password_hash))) throw unauthorized('INVALID_CREDENTIALS', 'Current password is incorrect');
  const hash = await bcrypt.hash(req.body.newPassword, config.bcryptRounds);
  await tx(async (c) => {
    await c.query('UPDATE accounts SET password_hash = ?, token_version = token_version + 1 WHERE id = ?', [hash, req.account.id]);
    await revokeAllRefreshTokens(req.account.id, c);   // every other device is logged out
  });
  const account = (await query('SELECT * FROM accounts WHERE id = ?', [req.account.id]))[0];
  res.json(await startSession(account));                // this device gets a fresh session
});

/**
 * Delete the account after password verification. Removes the account and (via cascading
 * foreign keys) every profile and its progress, Sparks, items and leaderboard entries.
 * Deleting a parent account also deletes all linked child profiles.
 */
router.delete('/', validate(z.object({ password: z.string().min(1), confirm: z.literal(true) })), async (req, res) => {
  if (!(await bcrypt.compare(req.body.password, req.account.password_hash))) throw unauthorized('INVALID_CREDENTIALS', 'Password is incorrect');
  await query('DELETE FROM accounts WHERE id = ?', [req.account.id]);
  res.json({ deleted: true });
});

module.exports = router;
