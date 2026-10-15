const express = require('express');
const { z } = require('zod');
const { query } = require('../../db');
const validate = require('../../middleware/validate');
const { requireAdmin, requireRole } = require('../../middleware/adminAuth');
const { notFound } = require('../../utils/errors');
const { AGE_GROUP_KEYS, ageGroupForDob } = require('../../utils/ageGroup');
const { audit } = require('../../utils/audit');

const router = express.Router();
router.use(requireAdmin, requireRole('full_admin'));   // user data is Full Admin only

const like = (s) => `%${s.replace(/[\\%_]/g, '\\$&')}%`;

// Search by username or email. Never returns password hashes or the Parent PIN.
router.get('/', validate(z.object({ q: z.string().trim().max(100).default(''), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) }), 'query'), async (req, res) => {
  const { q, page, pageSize } = req.validated.query;
  const where = q ? 'WHERE a.email LIKE ? OR p.username LIKE ?' : '';
  const params = q ? [like(q), like(q)] : [];
  const rows = await query(
    `SELECT a.id AS account_id, a.email, a.account_type, a.email_verified_at, a.created_at AS account_created,
            p.id AS profile_id, p.username, p.age_group, p.age_group_override, p.is_child
       FROM accounts a LEFT JOIN profiles p ON p.account_id = a.id
       ${where} ORDER BY a.id DESC, p.id LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]);
  const total = (await query(`SELECT COUNT(DISTINCT a.id) AS n FROM accounts a LEFT JOIN profiles p ON p.account_id = a.id ${where}`, params))[0].n;
  res.json({ page, pageSize, totalAccounts: total, rows: rows.map((r) => ({
    accountId: r.account_id, email: r.email, accountType: r.account_type, emailVerified: !!r.email_verified_at, createdAt: r.account_created,
    profileId: r.profile_id, username: r.username, ageGroup: r.age_group, ageGroupOverridden: !!r.age_group_override, isChild: !!r.is_child })) });
});

router.get('/:accountId', validate(z.object({ accountId: z.coerce.number().int().positive() }), 'params'), async (req, res) => {
  const a = (await query('SELECT id, email, account_type, phone, preferred_language, email_verified_at, created_at FROM accounts WHERE id = ?', [req.validated.params.accountId]))[0];
  if (!a) throw notFound('ACCOUNT_NOT_FOUND', 'Account not found');
  const profiles = await query('SELECT id, username, avatar_id, dob, age_group, age_group_override, is_child, language, mode, created_at FROM profiles WHERE account_id = ? ORDER BY id', [a.id]);
  await audit(req, 'user.viewed', { entityType: 'account', entityId: a.id });
  res.json({ account: a, profiles });
});

// Manually set (or clear) a profile's age group. A cleared override goes back to the DOB-derived group.
router.patch('/profiles/:id/age-group', validate(z.object({ id: z.coerce.number().int().positive() }), 'params'),
  validate(z.object({ ageGroup: z.enum(AGE_GROUP_KEYS).nullable(), reason: z.string().trim().min(3).max(200) })), async (req, res) => {
    const p = (await query('SELECT * FROM profiles WHERE id = ?', [req.validated.params.id]))[0];
    if (!p) throw notFound('PROFILE_NOT_FOUND', 'Profile not found');
    const next = req.body.ageGroup || ageGroupForDob(p.dob);
    await query('UPDATE profiles SET age_group_override = ?, age_group = ? WHERE id = ?', [req.body.ageGroup, next, p.id]);
    await audit(req, 'user.age_group_changed', { entityType: 'profile', entityId: p.id, details: { from: p.age_group, to: next, override: !!req.body.ageGroup, reason: req.body.reason } });
    res.json({ profileId: p.id, ageGroup: next, overridden: !!req.body.ageGroup });
  });

module.exports = router;
