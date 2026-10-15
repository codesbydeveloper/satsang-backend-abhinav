const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const config = require('../config');
const { query } = require('../db');
const validate = require('../middleware/validate');
const { usernameLimiter, authLimiter } = require('../middleware/rateLimit');
const S = require('../utils/schemas');
const { unauthorized } = require('../utils/errors');
const { checkUsername } = require('../utils/usernameFilter');
const { AGE_GROUPS } = require('../utils/ageGroup');
const { etDate, TZ } = require('../utils/time');

const router = express.Router();

// Startup config for the app: minimum supported version gate + authoritative server time.
router.get('/meta/config', (_req, res) => {
  const now = new Date();
  res.json({
    minAppVersion: config.minAppVersion, privacyPolicyVersion: config.privacyPolicyVersion,
    parentalConsentAge: config.parentalConsentAge, languages: ['en', 'gu'], modes: ['sanatan', 'satsang'],
    ageGroups: AGE_GROUPS.map((g) => ({ key: g.key, minAge: g.min, maxAge: g.max })),
    serverTimeUtc: now.toISOString(), gameDay: etDate(now), gameTimeZone: TZ,
  });
});

router.get('/avatars', async (_req, res) => {
  const rows = await query('SELECT id, avatar_key, kind, label, asset_url FROM avatars WHERE is_active = 1 ORDER BY id');
  res.json({ avatars: rows.map((a) => ({ id: a.id, key: a.avatar_key, kind: a.kind, label: a.label, assetUrl: a.asset_url })) });
});

router.get('/usernames/check', usernameLimiter, validate(z.object({ username: z.string().min(1).max(60) }), 'query'), async (req, res) => {
  const r = await checkUsername(req.validated.query.username);
  res.json(r.ok ? { available: true } : { available: false, reason: r.reason });
});

/**
 * Backend for the external "Delete my account" web page that Google Play's Data Safety section requires.
 * Works without the app: the person proves ownership with email + password.
 */
router.post('/public/delete-account', authLimiter, validate(z.object({ email: S.email, password: z.string().min(1), confirm: z.literal(true) })), async (req, res) => {
  const account = (await query('SELECT * FROM accounts WHERE email = ?', [req.body.email]))[0];
  const ok = await bcrypt.compare(req.body.password, account ? account.password_hash : bcrypt.hashSync('x', config.bcryptRounds));
  if (!account || !ok) throw unauthorized('INVALID_CREDENTIALS', 'Email or password is incorrect');
  await query('DELETE FROM accounts WHERE id = ?', [account.id]);
  res.json({ deleted: true });
});

module.exports = router;
