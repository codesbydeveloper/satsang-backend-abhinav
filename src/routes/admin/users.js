const express = require('express');
const { z } = require('zod');
const { query, tx } = require('../../db');
const { deleteAccountCompletely, deleteChildProfile } = require('../../utils/accountDeletion');
const validate = require('../../middleware/validate');
const { requireAdmin, requireRole } = require('../../middleware/adminAuth');
const { notFound, conflict } = require('../../utils/errors');
const { AGE_GROUP_KEYS, ageGroupForDob, ageOn } = require('../../utils/ageGroup');
const { audit } = require('../../utils/audit');
const { filterSchema, listSchema, queryUsers, toCsv, localDateTime } = require('../../utils/usersTable');

const router = express.Router();
router.use(requireAdmin, requireRole('full_admin'));   // user data is Full Admin only

// GET / and GET /export.csv share the Users table logic (filters, family grouping, sort): src/utils/usersTable.js.
router.get('/', validate(listSchema, 'query'), async (req, res) => {
  const { page, pageSize, sort } = req.validated.query;
  const { order, totalAccounts, totalRows, rows } = await queryUsers(req.validated.query);
  const countries = (await query('SELECT DISTINCT country FROM profiles WHERE country IS NOT NULL ORDER BY country')).map((c) => c.country);
  res.json({ page, pageSize, sort, order, totalAccounts, totalRows, countries, rows });
});

// The same rows as GET / with the same filters and sort, every family (no pages), as a CSV file. Columns: the
// table's, then accountId, profileId, parentAccountId. Audited with the count and the filters only.
router.get('/export.csv', validate(filterSchema, 'query'), async (req, res) => {
  const f = req.validated.query;
  const { order, rows } = await queryUsers({ ...f, pageSize: null });
  const filters = Object.fromEntries(Object.entries({ ...f, order, joinedSince: f.joinedSince?.toISOString() })
    .filter(([k, v]) => v !== undefined && v !== '' && !(k === 'classStatus' && v === 'all')));
  await audit(req, 'users.exported', { details: { count: rows.length, filters } });
  const day = localDateTime(new Date().toISOString()).slice(0, 10);   // today in DASHBOARD_TIMEZONE
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="satsang-spark-users-${day}.csv"`,
    'Cache-Control': 'no-store',
  });
  res.send(toCsv(rows));
});

// The "View" page: one account with all its playable profiles. Never returns the password or Parent PIN hashes.
router.get('/:accountId', validate(z.object({ accountId: z.coerce.number().int().positive() }), 'params'), async (req, res) => {
  const a = (await query(`SELECT id, email, account_type, phone, preferred_language, first_name, last_name, gender, email_verified_at, parent_pin_hash IS NOT NULL AS pin_set,
                                 privacy_policy_version, consent_accepted_at, created_at FROM accounts WHERE id = ?`, [req.validated.params.accountId]))[0];
  if (!a) throw notFound('ACCOUNT_NOT_FOUND', 'Account not found');
  const profiles = await query(
    `SELECT p.id, p.username, p.avatar_id, av.avatar_key, p.dob, p.age_group, p.age_group_override, p.is_child, p.language, p.mode, p.created_at,
            p.student_status, p.student_status_updated_at, p.student_verified_by, p.student_verified_at, p.student_sparks_awarded,
            vb.name AS verified_by_name, vb.email AS verified_by_email
       FROM profiles p JOIN avatars av ON av.id = p.avatar_id LEFT JOIN admins vb ON vb.id = p.student_verified_by
      WHERE p.account_id = ? ORDER BY p.id`, [a.id]);
  await audit(req, 'user.viewed', { entityType: 'account', entityId: a.id });
  res.json({
    account: {
      id: a.id, email: a.email, accountType: a.account_type, phone: a.phone, language: a.preferred_language,
      // private Sign Up details: on this detail page only, never in the user list
      firstName: a.first_name, lastName: a.last_name, gender: a.gender,
      emailVerified: !!a.email_verified_at, emailVerifiedAt: a.email_verified_at, parentPinSet: !!a.pin_set,
      privacyPolicyVersion: a.privacy_policy_version, consentAcceptedAt: a.consent_accepted_at, createdAt: a.created_at,
    },
    profiles: profiles.map((p) => ({
      id: p.id, username: p.username, avatarId: p.avatar_id, avatarKey: p.avatar_key, dob: p.dob, age: ageOn(p.dob),
      ageGroup: p.age_group, ageGroupOverridden: !!p.age_group_override, isChild: !!p.is_child, language: p.language, mode: p.mode, createdAt: p.created_at,
      studentStatus: p.student_status, studentStatusUpdatedAt: p.student_status_updated_at, studentVerifiedBy: p.student_verified_by,
      // the verifying admin's name (or email when no name is set) for the Admin Panel; null once reset
      studentVerifiedByName: p.student_verified_by ? (p.verified_by_name || p.verified_by_email || null) : null,
      studentVerifiedAt: p.student_verified_at, studentSparksAwarded: p.student_sparks_awarded,
    })),
  });
});

// Permanently delete an account. Cascades to every profile (incl. a parent's child profiles) and all
// profile-owned data, and ends the user's sessions. The owner (the parent, for a parent account) gets the deletion
// email; a completed entry (source admin) keeps the email/username for RETAINED_EMAIL_DAYS. The audit row keeps no
// email or username.
router.delete('/:accountId', validate(z.object({ accountId: z.coerce.number().int().positive() }), 'params'),
  validate(z.object({ confirm: z.literal(true), reason: z.string().trim().min(3).max(200) })), async (req, res) => {
    const a = (await query('SELECT id, account_type FROM accounts WHERE id = ?', [req.validated.params.accountId]))[0];
    if (!a) throw notFound('ACCOUNT_NOT_FOUND', 'Account not found');
    // a pending request for this account is now done: the shared service closes it so it leaves the queue
    const { profilesDeleted: profileCount, requestId } = await tx((c) => deleteAccountCompletely(c, a, { source: 'admin', decidedBy: req.admin.id, note: req.body.reason }));
    await audit(req, 'user.deleted', { entityType: 'account', entityId: a.id, details: { accountType: a.account_type, profilesDeleted: profileCount, requestId, reason: req.body.reason } });
    res.json({ deleted: true, accountId: a.id, profilesDeleted: profileCount });
  });

// Delete ONE child profile and only its own data (progress, activity, student status, reserved Sparks). The parent
// account and the other children keep their accounts, progress and Sparks. Adult profiles are refused: delete the
// account instead. Audited as child.deleted with ids only (child profile id, parent account id).
router.delete('/profiles/:id', validate(z.object({ id: z.coerce.number().int().positive() }), 'params'),
  validate(z.object({ confirm: z.literal(true), reason: z.string().trim().min(3).max(200) })), async (req, res) => {
    const p = (await query('SELECT id, account_id, is_child FROM profiles WHERE id = ?', [req.validated.params.id]))[0];
    if (!p) throw notFound('PROFILE_NOT_FOUND', 'Profile not found');
    if (!p.is_child) throw conflict('NOT_A_CHILD_PROFILE', 'Only child profiles can be deleted on their own. Delete the account instead.');
    const r = await tx((c) => deleteChildProfile(c, p.account_id, p.id, { source: 'admin', decidedBy: req.admin.id, note: req.body.reason }));
    if (!r) throw notFound('PROFILE_NOT_FOUND', 'Profile not found');   // deleted meanwhile
    await audit(req, 'child.deleted', { entityType: 'profile', entityId: p.id,
      details: { profileId: p.id, parentAccountId: p.account_id, requestId: r.requestId, reason: req.body.reason } });
    res.json({ deleted: true, profileId: p.id, parentAccountId: p.account_id, sessionsEnded: r.sessionsEnded });
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
