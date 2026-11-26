const express = require('express');
const { z } = require('zod');
const { query } = require('../db');
const validate = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const { feedbackLimiter } = require('../middleware/rateLimit');
const { forbidden, notFound, tooMany } = require('../utils/errors');
const { newsView, FEEDBACK_CATEGORIES, FEEDBACK_PER_HOUR, FEEDBACK_PER_DAY } = require('../utils/home');

// Home tab content for the app (Milestone 2, chunk 2.3A, contract 6.7): News & Updates and Feedback.
const router = express.Router();

// News & Updates: active items whose publish date has passed (server time), pinned first, then newest first. Public
// (no login needed, so Explore mode can show it too): news is not personal.
router.get('/news', validate(z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
}), 'query'), async (req, res) => {
  const { page, pageSize } = req.validated.query;
  const where = 'is_active = 1 AND publish_at <= UTC_TIMESTAMP()';
  const total = Number((await query(`SELECT COUNT(*) AS n FROM news WHERE ${where}`))[0].n);
  const rows = await query(`SELECT * FROM news WHERE ${where} ORDER BY is_pinned DESC, publish_at DESC, id DESC LIMIT ? OFFSET ?`,
    [pageSize, (page - 1) * pageSize]);
  res.json({ page, pageSize, total, items: rows.map((r) => newsView(r)) });
});

// Feedback from a playable profile: the own profile (independent account), or a child (parent area, or that child's
// own session). Rate limited per IP and per account (FEEDBACK_PER_HOUR / FEEDBACK_PER_DAY → 429 FEEDBACK_RATE_LIMITED).
const feedbackSchema = z.object({
  profileId: z.number().int().positive(),
  category: z.enum(FEEDBACK_CATEGORIES),
  message: z.string().trim().min(1).max(1000),
  appVersion: z.string().trim().max(32).optional(),
  device: z.string().trim().max(100).optional(),
});
router.post('/feedback', feedbackLimiter, requireAuth, validate(feedbackSchema), async (req, res) => {
  const b = req.body;
  const p = (await query('SELECT id FROM profiles WHERE id = ? AND account_id = ?', [b.profileId, req.account.id]))[0];
  if (!p) throw notFound('PROFILE_NOT_FOUND', 'Profile not found');
  if (req.account.account_type === 'parent' && req.profileId && req.profileId !== p.id) {
    throw forbidden('PARENT_MODE_REQUIRED', 'Switch to the parent area to send feedback for another profile');
  }
  const n = (await query(
    `SELECT SUM(created_at > UTC_TIMESTAMP() - INTERVAL 1 HOUR) AS hour, COUNT(*) AS day
       FROM feedback WHERE account_id = ? AND created_at > UTC_TIMESTAMP() - INTERVAL 1 DAY`, [req.account.id]))[0];
  if (Number(n.hour || 0) >= FEEDBACK_PER_HOUR || Number(n.day || 0) >= FEEDBACK_PER_DAY) {
    throw tooMany('FEEDBACK_RATE_LIMITED', 'Thank you! You have sent a lot of feedback recently. Please try again later.');
  }
  const r = await query(
    'INSERT INTO feedback (account_id, profile_id, category, message, app_version, device, created_at) VALUES (?,?,?,?,?,?,UTC_TIMESTAMP())',
    [req.account.id, p.id, b.category, b.message.normalize('NFC'), b.appVersion || null, b.device || null]);
  res.status(201).json({ id: r.insertId, received: true });
});

module.exports = router;
