const express = require('express');
const { z } = require('zod');
const { query } = require('../../db');
const validate = require('../../middleware/validate');
const { requireAdmin, requireRole } = require('../../middleware/adminAuth');
const { audit } = require('../../utils/audit');
const { REFERRAL_SETTINGS, readSettings, writeSettings } = require('../../utils/appSettings');

const router = express.Router();
router.use(requireAdmin, requireRole('full_admin'));   // referral data and settings: Full Admin only

const like = (s) => `%${s.replace(/[\\%_]/g, '\\$&')}%`;

/** camelCase view of the four referral settings (null maxPerReferrer = unlimited). */
const settingsView = (s) => ({
  newUserSparks: s.referral_new_user_sparks,
  referrerSparks: s.referral_referrer_sparks,
  windowHours: s.referral_window_hours,
  maxPerReferrer: s.referral_max_per_referrer,
});

router.get('/settings', async (_req, res) => {
  res.json({ settings: settingsView(await readSettings()) });
});

const n = (key) => z.number().int().min(REFERRAL_SETTINGS[key].min).max(REFERRAL_SETTINGS[key].max);
const settingsSchema = z.object({
  newUserSparks: n('referral_new_user_sparks').optional(),
  referrerSparks: n('referral_referrer_sparks').optional(),
  windowHours: n('referral_window_hours').optional(),
  maxPerReferrer: n('referral_max_per_referrer').nullable().optional(),   // null = unlimited
}).refine((b) => Object.keys(b).length > 0, 'Send at least one setting');

// Applies to codes entered from now on; amounts already recorded on a referral stay as they were.
router.put('/settings', validate(settingsSchema), async (req, res) => {
  const before = settingsView(await readSettings());
  const b = req.body;
  const after = settingsView(await writeSettings({
    ...(b.newUserSparks !== undefined ? { referral_new_user_sparks: b.newUserSparks } : {}),
    ...(b.referrerSparks !== undefined ? { referral_referrer_sparks: b.referrerSparks } : {}),
    ...(b.windowHours !== undefined ? { referral_window_hours: b.windowHours } : {}),
    ...(b.maxPerReferrer !== undefined ? { referral_max_per_referrer: b.maxPerReferrer } : {}),
  }, req.admin.id));
  const changed = Object.fromEntries(Object.keys(after).filter((k) => before[k] !== after[k]).map((k) => [k, { from: before[k], to: after[k] }]));
  await audit(req, 'referral_settings.updated', { entityType: 'app_settings', entityId: 'referral', details: changed });
  res.json({ settings: after });
});

/** The username of an account's own (non-child) profile; parent accounts have none. */
const ownUsername = (alias) => `(SELECT p.username FROM profiles p WHERE p.account_id = ${alias}.id AND p.is_child = 0 ORDER BY p.id LIMIT 1)`;

// Referrals list: code, who referred whom (usernames only, never emails), status and dates. Newest first.
router.get('/', validate(z.object({
  q: z.string().trim().max(100).default(''),
  status: z.enum(['all', 'waiting_for_first_quiz', 'qualified', 'credited', 'rejected']).default('all'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
}), 'query'), async (req, res) => {
  const { q, status, page, pageSize } = req.validated.query;
  const conds = [];
  const params = [];
  if (status !== 'all') { conds.push('rf.status = ?'); params.push(status); }
  if (q) {
    conds.push(`(rf.code LIKE ? OR ${ownUsername('ra')} LIKE ? OR ${ownUsername('ea')} LIKE ?)`);
    params.push(like(q.toUpperCase()), like(q), like(q));
  }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const from = `FROM referrals rf LEFT JOIN accounts ra ON ra.id = rf.referrer_account_id JOIN accounts ea ON ea.id = rf.referee_account_id ${where}`;
  const rows = await query(
    `SELECT rf.id, rf.code, rf.status, rf.new_user_sparks, rf.new_user_status, rf.referrer_sparks, rf.created_at, rf.qualified_at, rf.credited_at,
            rf.referrer_account_id, ra.account_type AS referrer_type, ${ownUsername('ra')} AS referrer_username,
            rf.referee_account_id, ea.account_type AS referee_type, ${ownUsername('ea')} AS referee_username
       ${from} ORDER BY rf.id DESC LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]);
  const total = Number((await query(`SELECT COUNT(*) AS n ${from}`, params))[0].n);
  res.json({
    page, pageSize, total,
    rows: rows.map((r) => ({
      id: r.id, code: r.code, status: r.status,
      referrer: r.referrer_account_id ? { accountId: r.referrer_account_id, accountType: r.referrer_type, username: r.referrer_username } : null,
      referee: { accountId: r.referee_account_id, accountType: r.referee_type, username: r.referee_username },
      newUserSparks: r.new_user_sparks, newUserStatus: r.new_user_status, referrerSparks: r.referrer_sparks,
      createdAt: r.created_at, qualifiedAt: r.qualified_at, creditedAt: r.credited_at,
    })),
  });
});

module.exports = router;
