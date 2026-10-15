const express = require('express');
const { z } = require('zod');
const { query } = require('../../db');
const validate = require('../../middleware/validate');
const { requireAdmin, requireRole } = require('../../middleware/adminAuth');

const router = express.Router();
router.use(requireAdmin, requireRole('full_admin'));

// Who changed what and when. Read-only: nothing in the API edits or deletes audit rows.
const schema = z.object({
  adminId: z.coerce.number().int().positive().optional(), action: z.string().max(60).optional(),
  entityType: z.string().max(40).optional(), from: z.string().optional(), to: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
router.get('/', validate(schema, 'query'), async (req, res) => {
  const f = req.validated.query; const where = []; const params = [];
  if (f.adminId) { where.push('admin_id = ?'); params.push(f.adminId); }
  if (f.action) { where.push('action LIKE ?'); params.push(`${f.action}%`); }
  if (f.entityType) { where.push('entity_type = ?'); params.push(f.entityType); }
  if (f.from) { where.push('created_at >= ?'); params.push(f.from); }
  if (f.to) { where.push('created_at <= ?'); params.push(f.to); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await query(`SELECT COUNT(*) AS n FROM audit_log ${w}`, params))[0].n;
  const rows = await query(`SELECT id, admin_id AS adminId, admin_email AS adminEmail, action, entity_type AS entityType, entity_id AS entityId, details, ip, created_at AS createdAt
                              FROM audit_log ${w} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, f.pageSize, (f.page - 1) * f.pageSize]);
  res.json({ page: f.page, pageSize: f.pageSize, total, entries: rows });
});

module.exports = router;
