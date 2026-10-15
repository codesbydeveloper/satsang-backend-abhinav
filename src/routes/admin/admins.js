const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const config = require('../../config');
const { query } = require('../../db');
const validate = require('../../middleware/validate');
const { requireAdmin, requireRole } = require('../../middleware/adminAuth');
const S = require('../../utils/schemas');
const { badRequest, notFound, conflict } = require('../../utils/errors');
const { audit } = require('../../utils/audit');

const router = express.Router();
router.use(requireAdmin, requireRole('full_admin'));

const view = (a) => ({ id: a.id, email: a.email, name: a.name, role: a.role, isActive: !!a.is_active, totpEnabled: !!a.totp_enabled, lastLoginAt: a.last_login_at, createdAt: a.created_at });
const idParam = z.object({ id: z.coerce.number().int().positive() });
const ROLES = z.enum(['full_admin', 'content_editor']);

async function target(req) {
  const a = (await query('SELECT * FROM admins WHERE id = ?', [req.validated.params.id]))[0];
  if (!a) throw notFound('ADMIN_NOT_FOUND', 'Admin not found');
  return a;
}
async function otherActiveFullAdmins(excludeId) {
  return (await query("SELECT COUNT(*) AS n FROM admins WHERE role = 'full_admin' AND is_active = 1 AND id <> ?", [excludeId]))[0].n;
}

router.get('/', async (_req, res) => {
  res.json({ admins: (await query('SELECT * FROM admins ORDER BY id')).map(view) });
});

router.post('/', validate(z.object({ email: S.email, name: z.string().trim().max(100).default(''), role: ROLES, temporaryPassword: z.string().min(12).max(72) })), async (req, res) => {
  const b = req.body;
  if ((await query('SELECT 1 FROM admins WHERE email = ?', [b.email])).length) throw conflict('EMAIL_TAKEN', 'An admin with this email already exists');
  const r = await query('INSERT INTO admins (email, name, password_hash, role) VALUES (?,?,?,?)',
    [b.email, b.name, await bcrypt.hash(b.temporaryPassword, config.bcryptRounds), b.role]);
  await audit(req, 'admin.created', { entityType: 'admin', entityId: r.insertId, details: { email: b.email, role: b.role } });
  res.status(201).json({ admin: view((await query('SELECT * FROM admins WHERE id = ?', [r.insertId]))[0]) });
});

router.patch('/:id', validate(idParam, 'params'), validate(z.object({ name: z.string().trim().max(100).optional(), role: ROLES.optional(), isActive: z.boolean().optional() })), async (req, res) => {
  const a = await target(req);
  const { name, role, isActive } = req.body;
  const losesFullAdmin = a.role === 'full_admin' && a.is_active && ((role && role !== 'full_admin') || isActive === false);
  if (losesFullAdmin && (await otherActiveFullAdmins(a.id)) === 0) throw badRequest('LAST_FULL_ADMIN', 'At least one active Full Admin must remain');
  if (isActive === false && a.id === req.admin.id) throw badRequest('CANNOT_DEACTIVATE_SELF', 'You cannot deactivate your own account');

  const sets = []; const vals = [];
  if (name !== undefined) { sets.push('name = ?'); vals.push(name); }
  if (role !== undefined) { sets.push('role = ?'); vals.push(role); }
  if (isActive !== undefined) { sets.push('is_active = ?'); vals.push(isActive ? 1 : 0); }
  if (role !== undefined || isActive === false) sets.push('token_version = token_version + 1');   // end their sessions
  if (sets.length) await query(`UPDATE admins SET ${sets.join(', ')} WHERE id = ?`, [...vals, a.id]);
  await audit(req, 'admin.updated', { entityType: 'admin', entityId: a.id, details: { name, role, isActive } });
  res.json({ admin: view((await query('SELECT * FROM admins WHERE id = ?', [a.id]))[0]) });
});

// Lost phone: remove 2FA so the admin enrols a new authenticator at next login.
router.post('/:id/reset-2fa', validate(idParam, 'params'), async (req, res) => {
  const a = await target(req);
  await query('UPDATE admins SET totp_secret_enc = NULL, totp_enabled = 0, token_version = token_version + 1 WHERE id = ?', [a.id]);
  await audit(req, 'admin.2fa_reset', { entityType: 'admin', entityId: a.id });
  res.json({ ok: true });
});

router.post('/:id/reset-password', validate(idParam, 'params'), validate(z.object({ newPassword: z.string().min(12).max(72) })), async (req, res) => {
  const a = await target(req);
  await query('UPDATE admins SET password_hash = ?, token_version = token_version + 1, failed_attempts = 0, locked_until = NULL WHERE id = ?',
    [await bcrypt.hash(req.body.newPassword, config.bcryptRounds), a.id]);
  await audit(req, 'admin.password_reset', { entityType: 'admin', entityId: a.id });
  res.json({ ok: true });
});

module.exports = router;
