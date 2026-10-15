const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const config = require('../config');
const { query } = require('../db');
const validate = require('../middleware/validate');
const { requireAuth, requireParent } = require('../middleware/auth');
const S = require('../utils/schemas');
const { unauthorized, conflict } = require('../utils/errors');
const { verifyPin } = require('../utils/pin');
const { forbidden, notFound } = require('../utils/errors');
const { etDate, addDays } = require('../utils/time');

const router = express.Router();
router.use(requireAuth, requireParent);

// First-time PIN creation (needs the account password). Changing it later goes through /reset.
router.post('/pin', validate(z.object({ pin: S.pin, password: z.string().min(1) })), async (req, res) => {
  if (req.account.parent_pin_hash) throw conflict('PIN_ALREADY_SET', 'A PIN already exists. Use PIN reset to change it.');
  if (!(await bcrypt.compare(req.body.password, req.account.password_hash))) throw unauthorized('INVALID_CREDENTIALS', 'Password is incorrect');
  await query('UPDATE accounts SET parent_pin_hash = ?, pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = ?',
    [await bcrypt.hash(req.body.pin, config.bcryptRounds), req.account.id]);
  res.status(201).json({ ok: true });
});

router.post('/pin/verify', validate(z.object({ pin: S.pin })), async (req, res) => {
  await verifyPin(req.account, req.body.pin);
  res.json({ ok: true });
});

// Forgot the PIN: reset with the account password.
router.post('/pin/reset', validate(z.object({ password: z.string().min(1), newPin: S.pin })), async (req, res) => {
  if (!(await bcrypt.compare(req.body.password, req.account.password_hash))) throw unauthorized('INVALID_CREDENTIALS', 'Password is incorrect');
  await query('UPDATE accounts SET parent_pin_hash = ?, pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = ?',
    [await bcrypt.hash(req.body.newPin, config.bcryptRounds), req.account.id]);
  res.json({ ok: true });
});


// Daily time + basic activity summary per child. Only available in parent mode (not while a child is active).
const reportSchema = z.object({ profileId: z.coerce.number().int().positive().optional(), days: z.coerce.number().int().min(1).max(90).default(7) });
router.get('/report', validate(reportSchema, 'query'), async (req, res) => {
  if (req.profileId) throw forbidden('PARENT_MODE_REQUIRED', 'Switch to parent mode to view reports');
  const { profileId, days } = req.validated.query;
  const kids = await query('SELECT id, username, age_group FROM profiles WHERE account_id = ? AND is_child = 1' + (profileId ? ' AND id = ?' : '') + ' ORDER BY id',
    profileId ? [req.account.id, profileId] : [req.account.id]);
  if (profileId && !kids.length) throw notFound('PROFILE_NOT_FOUND', 'Profile not found');
  const today = etDate();
  const from = etDate(addDays(new Date(), -(days - 1)));
  const rows = kids.length ? await query(
    `SELECT profile_id, game_day, active_seconds, learn_items_done, quizzes_completed, games_played, sparks_earned
       FROM profile_daily_activity WHERE profile_id IN (?) AND game_day BETWEEN ? AND ? ORDER BY game_day DESC`, [kids.map((k) => k.id), from, today]) : [];
  res.json({ from, to: today, timeZone: 'America/New_York', children: kids.map((k) => {
    const mine = rows.filter((r) => r.profile_id === k.id);
    const sum = (f) => mine.reduce((t, r) => t + r[f], 0);
    return { profileId: k.id, username: k.username, ageGroup: k.age_group,
      todaySeconds: (mine.find((r) => String(r.game_day).slice(0, 10) === today) || {}).active_seconds || 0,
      totals: { activeSeconds: sum('active_seconds'), learnItemsDone: sum('learn_items_done'), quizzesCompleted: sum('quizzes_completed'), gamesPlayed: sum('games_played'), sparksEarned: sum('sparks_earned') },
      byDay: mine.map((r) => ({ day: String(r.game_day).slice(0, 10), activeSeconds: r.active_seconds, learnItemsDone: r.learn_items_done, quizzesCompleted: r.quizzes_completed, gamesPlayed: r.games_played, sparksEarned: r.sparks_earned })) };
  }) });
});

module.exports = router;
