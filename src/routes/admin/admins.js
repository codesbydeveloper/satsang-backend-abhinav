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
const { newInvite, emailInvite, adminStatus } = require('../../utils/adminInvites');

const router = express.Router();
router.use(requireAdmin, requireRole('full_admin'));

const view = (a) => {
  const status = adminStatus(a);
  return {
    id: a.id, email: a.email, name: a.name, role: a.role, status, isActive: !!a.is_active,
    inviteExpiresAt: status === 'invited' ? a.invite_expires_at : null,
    invitedAt: a.invited_at, activatedAt: a.activated_at, lastLoginAt: a.last_login_at, createdAt: a.created_at,
  };
};
const idParam = z.object({ id: z.coerce.number().int().positive() });
const ROLES = z.enum(['full_admin', 'content_editor']);
const load = async (id) => (await query('SELECT * FROM admins WHERE id = ?', [id]))[0];

async function target(req) {
  const a = await load(req.validated.params.id);
  if (!a) throw notFound('ADMIN_NOT_FOUND', 'Admin not found');
  return a;
}
async function otherActiveFullAdmins(excludeId) {
  return (await query("SELECT COUNT(*) AS n FROM admins WHERE role = 'full_admin' AND is_active = 1 AND id <> ?", [excludeId]))[0].n;
}
const assertInvited = (a) => { if (adminStatus(a) !== 'invited') throw conflict('ADMIN_NOT_INVITED', 'This admin has already accepted their invite'); };
const assertNotInvited = (a) => { if (adminStatus(a) === 'invited') throw conflict('ADMIN_INVITED', 'This admin has not accepted their invite yet. Resend or cancel the invite instead.'); };

router.get('/', async (_req, res) => {
  res.json({ admins: (await query('SELECT * FROM admins ORDER BY id')).map(view) });
});

// Invite a new admin: created as "invited" (no password, not active) and emailed a 48-hour link to choose a password.
router.post('/', validate(z.object({ email: S.email, name: z.string().trim().min(1).max(100), role: ROLES })), async (req, res) => {
  const b = req.body;
  if ((await query('SELECT 1 FROM admins WHERE email = ?', [b.email])).length) throw conflict('ADMIN_EXISTS', 'An admin with this email already exists');
  const inv = newInvite();
  const r = await query(
    'INSERT INTO admins (email, name, password_hash, role, is_active, invite_token_hash, invite_expires_at, invited_by, invited_at) VALUES (?,?,NULL,?,0,?,?,?, UTC_TIMESTAMP())',
    [b.email, b.name, b.role, inv.hash, inv.expiresAt, req.admin.id]);
  const created = await load(r.insertId);
  try {
    await emailInvite(created, req.admin, inv.token);
  } catch (err) {
    await query('DELETE FROM admins WHERE id = ?', [r.insertId]);   // nothing half-made if the email cannot be sent
    throw err;
  }
  await audit(req, 'admin.invited', { entityType: 'admin', entityId: r.insertId, details: { email: b.email, role: b.role } });
  res.status(201).json({ admin: view(created) });
});

// New invite link for an admin who has not accepted yet; the previous link stops working.
router.post('/:id/resend-invite', validate(idParam, 'params'), async (req, res) => {
  const a = await target(req);
  assertInvited(a);
  const inv = newInvite();
  await emailInvite(a, req.admin, inv.token);
  await query('UPDATE admins SET invite_token_hash = ?, invite_expires_at = ?, invited_by = ?, invited_at = UTC_TIMESTAMP() WHERE id = ?',
    [inv.hash, inv.expiresAt, req.admin.id, a.id]);
  await audit(req, 'admin.invite_resent', { entityType: 'admin', entityId: a.id });
  res.json({ admin: view(await load(a.id)) });
});

// Cancel an invite (only for an admin who never accepted it): the row is removed.
router.delete('/:id', validate(idParam, 'params'), async (req, res) => {
  const a = await target(req);
  assertInvited(a);
  await query('DELETE FROM admins WHERE id = ? AND password_hash IS NULL', [a.id]);
  await audit(req, 'admin.invite_cancelled', { entityType: 'admin', entityId: a.id, details: { email: a.email } });
  res.json({ ok: true, cancelled: true });
});

// Rename, change role, deactivate / reactivate. `isActive` is accepted as an older name for `active`.
router.patch('/:id', validate(idParam, 'params'), validate(z.object({
  name: z.string().trim().min(1).max(100).optional(), role: ROLES.optional(), active: z.boolean().optional(), isActive: z.boolean().optional(),
})), async (req, res) => {
  const a = await target(req);
  const { name, role } = req.body;
  const active = req.body.active ?? req.body.isActive;
  const self = a.id === req.admin.id;
  const roleChanges = role !== undefined && role !== a.role;
  const activeChanges = active !== undefined && active !== !!a.is_active;

  if (active !== undefined) assertNotInvited(a);   // an invite is activated only by accepting it
  const losesFullAdmin = a.role === 'full_admin' && a.is_active && ((roleChanges && role !== 'full_admin') || (activeChanges && !active));
  if (losesFullAdmin && (await otherActiveFullAdmins(a.id)) === 0) throw conflict('LAST_FULL_ADMIN', 'At least one active Full Admin must remain');
  if (self && activeChanges && !active) throw badRequest('CANNOT_DEACTIVATE_SELF', 'You cannot deactivate your own account');
  if (self && roleChanges) throw badRequest('CANNOT_DEMOTE_SELF', 'You cannot change your own role');

  const sets = []; const vals = [];
  if (name !== undefined && name !== a.name) { sets.push('name = ?'); vals.push(name); }
  if (roleChanges) { sets.push('role = ?'); vals.push(role); }
  if (activeChanges) {
    sets.push('is_active = ?'); vals.push(active ? 1 : 0);
    if (active) sets.push('failed_attempts = 0', 'locked_until = NULL');
  }
  if (roleChanges || (activeChanges && !active)) sets.push('token_version = token_version + 1');   // end their sessions
  if (sets.length) await query(`UPDATE admins SET ${sets.join(', ')} WHERE id = ?`, [...vals, a.id]);

  const entity = { entityType: 'admin', entityId: a.id };
  if (name !== undefined && name !== a.name) await audit(req, 'admin.updated', { ...entity, details: { name } });
  if (roleChanges) await audit(req, 'admin.role_changed', { ...entity, details: { from: a.role, to: role } });
  if (activeChanges) await audit(req, active ? 'admin.reactivated' : 'admin.deactivated', entity);
  res.json({ admin: view(await load(a.id)) });
});

// Emergency: set a new password for an admin who has accepted their invite (sessions end).
router.post('/:id/reset-password', validate(idParam, 'params'), validate(z.object({ newPassword: z.string().min(12).max(72) })), async (req, res) => {
  const a = await target(req);
  assertNotInvited(a);
  await query('UPDATE admins SET password_hash = ?, token_version = token_version + 1, failed_attempts = 0, locked_until = NULL WHERE id = ?',
    [await bcrypt.hash(req.body.newPassword, config.bcryptRounds), a.id]);
  await audit(req, 'admin.password_reset', { entityType: 'admin', entityId: a.id });
  res.json({ ok: true });
});

module.exports = router;
