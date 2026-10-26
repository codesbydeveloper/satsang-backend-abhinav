const express = require('express');
const { z } = require('zod');
const { query, tx } = require('../../db');
const validate = require('../../middleware/validate');
const { requireAdmin, requireRole } = require('../../middleware/adminAuth');
const { notFound, conflict } = require('../../utils/errors');
const { audit } = require('../../utils/audit');
const { deleteAccountCompletely } = require('../../utils/accountDeletion');

const router = express.Router();
router.use(requireAdmin, requireRole('full_admin'));   // user data is Full Admin only

const like = (s) => `%${s.replace(/[\\%_]/g, '\\$&')}%`;
const idParam = validate(z.object({ id: z.coerce.number().int().positive() }), 'params');

// Live account fields are joined only while the account still exists (pending / rejected).
// Username is the adult's own profile; parent accounts have no profile of their own, so it is null.
const SELECT = `
  SELECT r.*, a.email, a.email_verified_at, a.created_at AS account_created, ad.name AS decided_by_name,
         (SELECT p.username FROM profiles p WHERE p.account_id = a.id AND p.is_child = 0 ORDER BY p.id LIMIT 1) AS username,
         (SELECT COUNT(*) FROM profiles p WHERE p.account_id = a.id AND p.is_child = 1) AS child_profiles
    FROM account_deletion_requests r
    LEFT JOIN accounts a ON a.id = r.account_id AND r.status <> 'completed'
    LEFT JOIN admins ad ON ad.id = r.decided_by`;

const row = (r) => {
  const gone = r.status === 'completed';
  return {
    id: r.id, accountId: r.account_id, accountType: r.account_type, source: r.source, status: r.status,
    username: gone ? null : r.username, email: gone ? null : r.email,
    emailVerified: gone ? null : !!r.email_verified_at,
    childProfiles: gone ? (r.account_type === 'parent' ? r.profiles_deleted : 0) : Number(r.child_profiles),
    profilesDeleted: r.profiles_deleted, requestedAt: r.requested_at,
    deletedByOwner: r.status === 'completed' && !r.decided_by,   // deleted in the app (DELETE /me): no admin decided
    decidedAt: r.decided_at, decidedBy: r.decided_by ? { id: r.decided_by, name: r.decided_by_name } : null, decisionNote: r.decision_note,
  };
};

// The list behind the tabs. `counts` uses the same search/source filters but every status, for the tab badges.
const listSchema = z.object({
  status: z.enum(['pending', 'completed', 'rejected', 'all']).default('pending'),
  q: z.string().trim().max(100).default(''),
  source: z.enum(['app', 'web', 'all']).default('all'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
router.get('/', validate(listSchema, 'query'), async (req, res) => {
  const { status, q, source, page, pageSize } = req.validated.query;
  const where = []; const params = [];
  if (q) {
    where.push('(a.email LIKE ? OR EXISTS (SELECT 1 FROM profiles p WHERE p.account_id = a.id AND p.username LIKE ?))');
    params.push(like(q), like(q));
  }
  if (source !== 'all') { where.push('r.source = ?'); params.push(source); }
  const base = `FROM account_deletion_requests r LEFT JOIN accounts a ON a.id = r.account_id AND r.status <> 'completed' ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;

  const countRows = await query(`SELECT r.status AS k, COUNT(*) AS n ${base} GROUP BY r.status`, params);
  const counts = { pending: 0, completed: 0, rejected: 0, all: 0 };
  for (const c of countRows) { counts[c.k] = Number(c.n); counts.all += Number(c.n); }

  const statusWhere = status === 'all' ? '' : `${where.length ? ' AND' : ' WHERE'} r.status = ?`;
  const rows = await query(
    `${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}${statusWhere}
      ORDER BY r.requested_at DESC, r.id DESC LIMIT ? OFFSET ?`,
    [...params, ...(status === 'all' ? [] : [status]), pageSize, (page - 1) * pageSize]);
  res.json({ status, page, pageSize, total: counts[status], counts, rows: rows.map(row) });
});

// The "View" page: the request plus the account's profiles (while the account exists). No DOBs.
router.get('/:id', idParam, async (req, res) => {
  const r = (await query(`${SELECT} WHERE r.id = ?`, [req.validated.params.id]))[0];
  if (!r) throw notFound('DELETION_REQUEST_NOT_FOUND', 'Deletion request not found');
  const profiles = r.status === 'completed' ? [] : await query(
    `SELECT p.id, p.username, p.is_child, p.age_group, av.avatar_key, p.created_at
       FROM profiles p JOIN avatars av ON av.id = p.avatar_id WHERE p.account_id = ? ORDER BY p.id`, [r.account_id]);
  await audit(req, 'deletion_request.viewed', { entityType: 'deletion_request', entityId: r.id });
  res.json({
    request: row(r),
    account: r.status === 'completed' ? null : { id: r.account_id, email: r.email, accountType: r.account_type, emailVerified: !!r.email_verified_at, createdAt: r.account_created },
    profiles: profiles.map((p) => ({ id: p.id, username: p.username, isChild: !!p.is_child, ageGroup: p.age_group, avatarKey: p.avatar_key, createdAt: p.created_at })),
  });
});

/** Lock a pending request inside a transaction, or throw 404 / 409. */
async function lockPending(c, id) {
  const r = (await c.query('SELECT * FROM account_deletion_requests WHERE id = ? FOR UPDATE', [id]))[0];
  if (!r) throw notFound('DELETION_REQUEST_NOT_FOUND', 'Deletion request not found');
  if (r.status !== 'pending') throw conflict('DELETION_REQUEST_DECIDED', `This request is already ${r.status}`);
  return r;
}

// Approve: permanently deletes the account, all its profiles (a parent's child profiles too) and their
// data, and ends the user's sessions. The audit row keeps no email or username.
router.post('/:id/approve', idParam, validate(z.object({ confirm: z.literal(true), note: z.string().trim().max(200).optional() })), async (req, res) => {
  const result = await tx(async (c) => {
    const r = await lockPending(c, req.validated.params.id);
    const { profilesDeleted } = await deleteAccountCompletely(c, { id: r.account_id, account_type: r.account_type },
      { decidedBy: req.admin.id, note: req.body.note || null });   // also completes this request
    return { r, profilesDeleted };
  });
  const { r, profilesDeleted } = result;
  await audit(req, 'deletion_request.approved', { entityType: 'deletion_request', entityId: r.id,
    details: { accountId: r.account_id, accountType: r.account_type, source: r.source, profilesDeleted, note: req.body.note || null } });
  res.json({ id: r.id, status: 'completed', accountId: r.account_id, profilesDeleted });
});

// Reject: the account is kept. A reason is required; the owner can ask again later.
router.post('/:id/reject', idParam, validate(z.object({ reason: z.string().trim().min(3).max(200) })), async (req, res) => {
  const r = await tx(async (c) => {
    const r = await lockPending(c, req.validated.params.id);
    await c.query("UPDATE account_deletion_requests SET status = 'rejected', decided_by = ?, decided_at = UTC_TIMESTAMP(), decision_note = ? WHERE id = ?",
      [req.admin.id, req.body.reason, r.id]);
    return r;
  });
  await audit(req, 'deletion_request.rejected', { entityType: 'deletion_request', entityId: r.id,
    details: { accountId: r.account_id, accountType: r.account_type, source: r.source, reason: req.body.reason } });
  res.json({ id: r.id, status: 'rejected', accountId: r.account_id });
});

module.exports = router;
