const express = require('express');
const { z } = require('zod');
const { query } = require('../../db');
const validate = require('../../middleware/validate');
const { requireAdmin, requireRole } = require('../../middleware/adminAuth');
const { audit } = require('../../utils/audit');
const { notFound } = require('../../utils/errors');
const { FEEDBACK_CATEGORIES } = require('../../utils/home');

// App feedback (Milestone 2, chunk 2.3A): Full Admin only. Shows the profile's username (never email or DOB).
const router = express.Router();
router.use(requireAdmin, requireRole('full_admin'));

const like = (s) => `%${s.replace(/[\\%_]/g, '\\$&')}%`;
const SELECT = `SELECT f.*, p.username, p.is_child FROM feedback f JOIN profiles p ON p.id = f.profile_id`;
const view = (r) => ({
  id: Number(r.id), accountId: Number(r.account_id), profileId: Number(r.profile_id), username: r.username, isChild: !!r.is_child,
  category: r.category, message: r.message, appVersion: r.app_version, device: r.device, status: r.status,
  adminNote: r.admin_note, resolvedBy: r.resolved_by == null ? null : Number(r.resolved_by), resolvedAt: r.resolved_at, createdAt: r.created_at,
});

// Newest first. q matches the message or the username; "#12" matches feedback id 12.
router.get('/', validate(z.object({
  q: z.string().trim().max(100).default(''),
  status: z.enum(['all', 'open', 'resolved']).default('all'),
  category: z.enum(['all', ...FEEDBACK_CATEGORIES]).default('all'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
}), 'query'), async (req, res) => {
  const { q, status, category, page, pageSize } = req.validated.query;
  const conds = [];
  const params = [];
  if (status !== 'all') { conds.push('f.status = ?'); params.push(status); }
  if (category !== 'all') { conds.push('f.category = ?'); params.push(category); }
  if (/^#\d+$/.test(q)) { conds.push('f.id = ?'); params.push(Number(q.slice(1))); }
  else if (q) { conds.push('(f.message LIKE ? OR p.username LIKE ?)'); params.push(like(q), like(q)); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const total = Number((await query(`SELECT COUNT(*) AS n FROM feedback f JOIN profiles p ON p.id = f.profile_id ${where}`, params))[0].n);
  const open = Number((await query("SELECT COUNT(*) AS n FROM feedback WHERE status = 'open'"))[0].n);
  const rows = await query(`${SELECT} ${where} ORDER BY f.id DESC LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]);
  res.json({ page, pageSize, total, openCount: open, items: rows.map(view) });
});

// Mark resolved (or open again), with an optional note for the other admins.
router.patch('/:id', validate(z.object({ id: z.coerce.number().int().positive() }), 'params'), validate(z.object({
  status: z.enum(['open', 'resolved']),
  note: z.string().trim().max(500).nullable().optional(),
})), async (req, res) => {
  const id = req.validated.params.id;
  const cur = (await query(`${SELECT} WHERE f.id = ?`, [id]))[0];
  if (!cur) throw notFound('FEEDBACK_NOT_FOUND', 'Feedback not found');
  const { status, note } = req.body;
  await query(
    `UPDATE feedback SET status = ?, admin_note = ?, resolved_by = ?, resolved_at = ${status === 'resolved' ? 'UTC_TIMESTAMP()' : 'NULL'} WHERE id = ?`,
    [status, note === undefined ? cur.admin_note : (note || null), status === 'resolved' ? req.admin.id : null, id]);
  if (cur.status !== status || (note !== undefined && (note || null) !== cur.admin_note)) {
    await audit(req, status === 'resolved' ? 'feedback.resolved' : 'feedback.reopened', { entityType: 'feedback', entityId: id, details: { from: cur.status, to: status, noteChanged: note !== undefined } });
  }
  res.json({ feedback: view((await query(`${SELECT} WHERE f.id = ?`, [id]))[0]) });
});

module.exports = router;
