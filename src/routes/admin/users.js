const express = require('express');
const { z } = require('zod');
const { query, tx } = require('../../db');
const { deleteAccountCompletely } = require('../../utils/accountDeletion');
const validate = require('../../middleware/validate');
const { requireAdmin, requireRole } = require('../../middleware/adminAuth');
const { notFound } = require('../../utils/errors');
const { AGE_GROUP_KEYS, ageGroupForDob, ageGroupLabel, ageOn } = require('../../utils/ageGroup');
const { toIso, toSql } = require('../../utils/time');
const { audit } = require('../../utils/audit');
const { STUDENT_STATUSES } = require('../../utils/studentStatus');

const router = express.Router();
router.use(requireAdmin, requireRole('full_admin'));   // user data is Full Admin only

const like = (s) => `%${s.replace(/[\\%_]/g, '\\$&')}%`;

// ---- The Users table (client 23 Nov 2026) ----
// One row per playable profile, grouped by account ("family"): first the account row (an adult's own profile, or a
// parent account, which has no profile of its own), then each child profile as its own row (parentAccountId set).
// A child has no email: its row carries the parent's email with isParentEmail: true. Child profiles have no name.
// DOB is returned here (Full Admin only: this router) and never by the app API. Never password hashes or the PIN.
//
// Filters match single rows. A family is listed when any of its rows matches; its account row always comes first
// (matched: false → the panel greys it) and only the matching children follow. Sorting orders families by their
// account row, and the children inside a family by the same column. page/pageSize/totalAccounts count families.

// Old ?studentStatus= (one status or a comma list, e.g. the dashboard's pending_verification,interested) still works.
const statusList = z.string().transform((s) => [...new Set(s.split(',').map((x) => x.trim()).filter(Boolean))])
  .pipe(z.array(z.enum(STUDENT_STATUSES)).min(1));
// The panel's Class Status filter. interested includes interest_confirmed; not_enrolled includes not_asked
// (never answered), so every profile falls under exactly one of the four.
const CLASS_STATUS = {
  verified: ['verified'], pending_verification: ['pending_verification'],
  interested: ['interested', 'interest_confirmed'], not_enrolled: ['not_enrolled', 'not_asked'],
};
const AG_ORDER = `NULLIF(FIELD(h.age_group, ${AGE_GROUP_KEYS.map((k) => `'${k.replace(/'/g, "''")}'`).join(', ')}), 0)`;
const SORTS = {   // sql: on the family's account row (h); key(): the same for the children inside a family
  name: { sql: 'LOWER(h.name)', key: (r) => r.name?.toLowerCase() ?? null },
  username: { sql: 'LOWER(h.username)', key: (r) => r.username?.toLowerCase() ?? null },
  accountType: { sql: 'h.row_type', key: (r) => r.row_type },
  country: { sql: 'h.country', key: (r) => r.country },
  dob: { sql: 'h.dob', key: (r) => r.dob },
  ageGroup: { sql: AG_ORDER, key: (r) => { const i = AGE_GROUP_KEYS.indexOf(r.age_group); return i < 0 ? null : i; } },
  email: { sql: 'LOWER(h.email)', key: (r) => r.email.toLowerCase() },
  joined: { sql: 'h.joined', key: (r) => r.joined },
};
const listSchema = z.object({
  q: z.string().trim().max(100).default(''),
  country: z.string().trim().regex(/^[A-Za-z]{2}$/).transform((s) => s.toUpperCase()).optional(),
  ageGroup: z.enum(AGE_GROUP_KEYS).optional(),
  accountType: z.enum(['adult', 'parent', 'child']).optional(),
  classStatus: z.enum(['all', ...Object.keys(CLASS_STATUS)]).default('all'),
  studentStatus: statusList.optional(),
  // accounts created at/after this instant (account rows only): the dashboard's "New registrations today"
  joinedSince: z.string().datetime({ offset: true }).transform((s) => new Date(s)).optional(),
  sort: z.enum(Object.keys(SORTS)).default('joined'),
  order: z.enum(['asc', 'desc']).optional(),   // default: newest first for joined, A→Z otherwise
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

// Every displayed row: account rows (with the adult's own profile, if any) + child profile rows.
const ROWS = `WITH r AS (
  SELECT a.id AS account_id, NULL AS parent_account_id, own.id AS profile_id, 0 AS is_child_row,
         CAST(a.account_type AS CHAR(10)) AS row_type, NULLIF(TRIM(CONCAT_WS(' ', a.first_name, a.last_name)), '') AS name,
         own.username, own.country, own.dob, own.age_group, own.age_group_override, own.student_status,
         a.email, a.email_verified_at, a.created_at AS joined
    FROM accounts a
    LEFT JOIN profiles own ON own.id = (SELECT MIN(x.id) FROM profiles x WHERE x.account_id = a.id AND x.is_child = 0)
  UNION ALL
  SELECT a.id, a.id, c.id, 1, 'child', NULL, c.username, c.country, c.dob, c.age_group, c.age_group_override, c.student_status,
         a.email, a.email_verified_at, c.created_at
    FROM profiles c JOIN accounts a ON a.id = c.account_id WHERE c.is_child = 1)`;

router.get('/', validate(listSchema, 'query'), async (req, res) => {
  const { q, country, ageGroup, accountType, classStatus, studentStatus, joinedSince, sort, page, pageSize } = req.validated.query;
  const order = req.validated.query.order || (sort === 'joined' ? 'desc' : 'asc');
  const conds = []; const params = [];
  if (q) { conds.push('(LOWER(r.name) LIKE ? OR LOWER(r.username) LIKE ? OR LOWER(r.email) LIKE ?)'); const l = like(q.toLowerCase()); params.push(l, l, l); }
  if (country) { conds.push('r.country = ?'); params.push(country); }
  if (ageGroup) { conds.push('r.age_group = ?'); params.push(ageGroup); }
  if (accountType) { conds.push('r.row_type = ?'); params.push(accountType); }
  if (joinedSince) { conds.push('(r.is_child_row = 0 AND r.joined >= ?)'); params.push(toSql(joinedSince)); }
  for (const list of [classStatus !== 'all' && CLASS_STATUS[classStatus], studentStatus]) {
    if (list) { conds.push(`r.student_status IN (${list.map(() => '?').join(', ')})`); params.push(...list); }
  }
  const match = conds.length ? conds.join(' AND ') : '1';
  const s = SORTS[sort]; const dir = order === 'desc' ? 'DESC' : 'ASC';

  const fam = `${ROWS}, fam AS (SELECT DISTINCT r.account_id FROM r WHERE ${match})`;
  const total = (await query(`${fam} SELECT COUNT(*) AS n FROM fam`, params))[0].n;
  // rows matching the filters themselves (greyed parent rows not counted): equals the dashboard card numbers
  const totalRows = (await query(`${ROWS} SELECT COUNT(*) AS n FROM r WHERE ${match}`, params))[0].n;
  const heads = await query(
    `${fam} SELECT h.account_id FROM r h JOIN fam f ON f.account_id = h.account_id WHERE h.is_child_row = 0
      ORDER BY (${s.sql}) IS NULL, ${s.sql} ${dir}, h.account_id ${sort === 'joined' ? dir : 'DESC'} LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]);
  const ids = heads.map((x) => x.account_id);

  let rows = [];
  if (ids.length) {
    const all = await query(`${ROWS} SELECT r.*, (${match}) AS matched FROM r WHERE r.account_id IN (?)`, [...params, ids]);
    const cmp = (x, y) => {   // children inside a family: same column and direction, empty values last, then username
      const a = s.key(x); const b = s.key(y);
      if (a === b || (a == null && b == null)) return (x.username || '').localeCompare(y.username || '') || x.profile_id - y.profile_id;
      if (a == null) return 1;
      if (b == null) return -1;
      return (a < b ? -1 : 1) * (dir === 'DESC' ? -1 : 1);
    };
    rows = ids.flatMap((id) => {
      const family = all.filter((r) => r.account_id === id);
      return [family.find((r) => !r.is_child_row), ...family.filter((r) => r.is_child_row && r.matched).sort(cmp)];
    }).map(rowView);
  }
  const countries = (await query('SELECT DISTINCT country FROM profiles WHERE country IS NOT NULL ORDER BY country')).map((c) => c.country);
  res.json({ page, pageSize, sort, order, totalAccounts: total, totalRows, countries, rows });
});

function rowView(r) {
  const child = !!r.is_child_row;
  return {
    accountId: r.account_id, parentAccountId: child ? r.parent_account_id : null, profileId: r.profile_id,
    accountType: r.row_type, isChild: child, name: r.name, username: r.username, country: r.country, dob: r.dob,
    ageGroup: ageGroupLabel(r.age_group), ageGroupKey: r.age_group, ageGroupOverridden: !!r.age_group_override,
    email: r.email, isParentEmail: child, studentStatus: r.profile_id ? r.student_status : null,
    emailVerified: !!r.email_verified_at, joined: toIso(r.joined), createdAt: r.joined,
    matched: !!r.matched,   // false: an account row shown only because one of its children matched
  };
}

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
