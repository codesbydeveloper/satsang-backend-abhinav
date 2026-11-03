const express = require('express');
const { z } = require('zod');
const { query } = require('../../db');
const validate = require('../../middleware/validate');
const { requireAdmin, requireRole } = require('../../middleware/adminAuth');
const { AGE_GROUP_KEYS } = require('../../utils/ageGroup');
const { etDate, fromSql } = require('../../utils/time');

const router = express.Router();
router.use(requireAdmin, requireRole('full_admin'));   // user data is Full Admin only

/** The last `n` Eastern Time calendar dates, oldest first, ending today. */
function lastEtDates(n, today = etDate()) {
  const [y, m, d] = today.split('-').map(Number);
  return Array.from({ length: n }, (_, i) => new Date(Date.UTC(y, m - 1, d - (n - 1 - i))).toISOString().slice(0, 10));
}

const countBy = (rows, keys) => {
  const counts = Object.fromEntries(rows.map((r) => [r.k, Number(r.n)]));
  return keys.map((key) => ({ key, count: counts[key] || 0 }));
};

// Everything the Admin Panel dashboard shows, in one call. Counts are live; "today" and the chart
// days are America/New_York calendar days. DOBs and emails are never returned here.
const schema = z.object({
  days: z.coerce.number().int().refine((n) => n === 7 || n === 30, 'days must be 7 or 30').default(7),
  recent: z.coerce.number().int().min(1).max(50).default(5),
  activity: z.coerce.number().int().min(1).max(50).default(10),
});
router.get('/', validate(schema, 'query'), async (req, res) => {
  const { days, recent, activity } = req.validated.query;

  const [acc] = await query(`SELECT COUNT(*) AS total, COALESCE(SUM(account_type = 'adult'), 0) AS adult, COALESCE(SUM(account_type = 'parent'), 0) AS parent FROM accounts`);
  const [prof] = await query('SELECT COUNT(*) AS total, COALESCE(SUM(is_child = 1), 0) AS child FROM profiles');

  // Bucket recent sign-ups by Eastern Time day in JS (MySQL time-zone tables may not be loaded on the host).
  const dates = lastEtDates(days);
  const created = await query('SELECT created_at FROM accounts WHERE created_at >= UTC_TIMESTAMP() - INTERVAL ? DAY', [days + 1]);
  const perDay = Object.fromEntries(dates.map((d) => [d, 0]));
  for (const r of created) { const d = etDate(fromSql(r.created_at)); if (d in perDay) perDay[d] += 1; }
  const series = dates.map((date) => ({ date, count: perDay[date] }));

  const ageRows = await query('SELECT age_group AS k, COUNT(*) AS n FROM profiles GROUP BY age_group');
  const modeRows = await query("SELECT COALESCE(mode, 'not_set') AS k, COUNT(*) AS n FROM profiles GROUP BY k");
  const langRows = await query('SELECT language AS k, COUNT(*) AS n FROM profiles GROUP BY language');
  const modes = countBy(modeRows, ['sanatan', 'satsang', 'not_set']).filter((m) => m.key !== 'not_set' || m.count > 0);

  // New adult and parent accounts plus new child profiles, newest first.
  const recentRows = await query(
    `SELECT * FROM (
       (SELECT a.id AS account_id, p.id AS profile_id, a.account_type AS type, p.username, p.age_group, a.created_at
          FROM accounts a LEFT JOIN profiles p ON p.account_id = a.id AND p.is_child = 0
         ORDER BY a.created_at DESC, a.id DESC LIMIT ?)
       UNION ALL
       (SELECT p.account_id, p.id, 'child', p.username, p.age_group, p.created_at
          FROM profiles p WHERE p.is_child = 1 ORDER BY p.created_at DESC, p.id DESC LIMIT ?)
     ) r ORDER BY created_at DESC, account_id DESC, profile_id DESC LIMIT ?`, [recent, recent, recent]);

  const activityRows = await query(
    `SELECT l.id, l.admin_id AS adminId, ad.name AS adminName, l.admin_email AS adminEmail, l.action, l.entity_type AS entityType,
            l.entity_id AS entityId, l.details, l.created_at AS createdAt
       FROM audit_log l LEFT JOIN admins ad ON ad.id = l.admin_id ORDER BY l.id DESC LIMIT ?`, [activity]);

  res.json({
    generatedAt: new Date().toISOString(),
    timeZone: 'America/New_York',
    totals: {
      accounts: Number(acc.total), adultAccounts: Number(acc.adult), parentAccounts: Number(acc.parent),
      profiles: Number(prof.total), childProfiles: Number(prof.child), newRegistrationsToday: series[series.length - 1].count,
    },
    ageGroups: countBy(ageRows, AGE_GROUP_KEYS).map(({ key, count }) => ({ ageGroup: key, count })),
    registrations: { days, total: series.reduce((s, x) => s + x.count, 0), series },
    modes, languages: countBy(langRows, ['en', 'gu']),
    recentRegistrations: recentRows.map((r) => ({
      accountId: r.account_id, profileId: r.profile_id, type: r.type, username: r.username, ageGroup: r.age_group, createdAt: r.created_at })),
    recentAdminActivity: activityRows,
  });
});

module.exports = router;
