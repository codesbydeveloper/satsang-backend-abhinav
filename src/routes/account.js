const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const config = require('../config');
const { query, tx } = require('../db');
const validate = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const S = require('../utils/schemas');
const { unauthorized, badRequest } = require('../utils/errors');
const { accountView, profileView, loadProfiles } = require('../utils/profiles');
const { revokeAllRefreshTokens } = require('../utils/tokens');
const { startSession } = require('../utils/session');

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
