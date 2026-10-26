const express = require('express');
const { z } = require('zod');
const { query, tx } = require('../../db');
const { deleteAccountCompletely } = require('../../utils/accountDeletion');
const validate = require('../../middleware/validate');
const { requireAdmin, requireRole } = require('../../middleware/adminAuth');
const { notFound } = require('../../utils/errors');
const { AGE_GROUP_KEYS, ageGroupForDob, ageOn } =require('../../utils/ageGroup');
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

// The "View" page: one account with all its playable profiles. Never returns the password or Parent PIN hashes.
router.get('/:accountId', validate(z.object({ accountId: z.coerce.number().int().positive() }), 'params'), async (req, res) => {
  const a = (await query(`SELECT id, email, account_type, phone, preferred_language, email_verified_at, parent_pin_hash IS NOT NULL AS pin_set,
                                 privacy_policy_version, consent_accepted_at, created_at FROM accounts WHERE id = ?`, [req.validated.params.accountId]))[0];
  if (!a) throw notFound('ACCOUNT_NOT_FOUND', 'Account not found');
  const profiles = await query(
    `SELECT p.id, p.username, p.avatar_id, av.avatar_key, p.dob, p.age_group, p.age_group_override, p.is_child, p.language, p.mode, p.created_at
       FROM profiles p JOIN avatars av ON av.id = p.avatar_id WHERE p.account_id = ? ORDER BY p.id`, [a.id]);
  await audit(req, 'user.viewed', { entityType: 'account', entityId: a.id });
  res.json({
    account: {
      id: a.id, email: a.email, accountType: a.account_type, phone: a.phone, language: a.preferred_language,
      emailVerified: !!a.email_verified_at, emailVerifiedAt: a.email_verified_at, parentPinSet: !!a.pin_set,
      privacyPolicyVersion: a.privacy_policy_version, consentAcceptedAt: a.consent_accepted_at, createdAt: a.created_at,
    },
    profiles: profiles.map((p) => ({
      id: p.id, username: p.username, avatarId: p.avatar_id, avatarKey: p.avatar_key, dob: p.dob, age: ageOn(p.dob),
      ageGroup: p.age_group, ageGroupOverridden: !!p.age_group_override, isChild: !!p.is_child, language: p.language, mode: p.mode, createdAt: p.created_at,
    })),
  });
});

// Permanently delete an account. Cascades to every profile (incl. a parent's child profiles) and all
// profile-owned data, and ends the user's sessions. The audit row keeps no email or username.
router.delete('/:accountId', validate(z.object({ accountId: z.coerce.number().int().positive() }), 'params'),
  validate(z.object({ confirm: z.literal(true), reason: z.string().trim().min(3).max(200) })), async (req, res) => {
    const a = (await query('SELECT id, account_type FROM accounts WHERE id = ?', [req.validated.params.accountId]))[0];
    if (!a) throw notFound('ACCOUNT_NOT_FOUND', 'Account not found');
    // a pending request for this account is now done: the shared service closes it so it leaves the queue
    const { profilesDeleted: profileCount } = await tx((c) => deleteAccountCompletely(c, a, { decidedBy: req.admin.id, note: 'Deleted from the Users page' }));
    await audit(req, 'user.deleted', { entityType: 'account', entityId: a.id, details: { accountType: a.account_type, profilesDeleted: profileCount, reason: req.body.reason } });
    res.json({ deleted: true, accountId: a.id, profilesDeleted: profileCount });
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
