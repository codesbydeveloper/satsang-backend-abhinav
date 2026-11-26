const express = require('express');
const { z } = require('zod');
const config = require('../../config');
const validate = require('../../middleware/validate');
const { requireAdmin, requireRole } = require('../../middleware/adminAuth');
const { audit } = require('../../utils/audit');
const { writeText } = require('../../utils/appSettings');
const { donateUrl } = require('../../utils/home');
const dailySpin = require('../../services/dailySpin');
const streak = require('../../services/streak');

// Home tab settings (Milestone 2, chunk 2.3A): Daily Spin wheel, Streak Bonus amounts, Donate URL. Full Admin only;
// every change is audited with from → to. Built-in defaults are placeholders to be confirmed by Loyadham.
const router = express.Router();
router.use(requireAdmin, requireRole('full_admin'));
const NOTE = 'Built-in values are defaults to be confirmed by Loyadham.';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function segmentsView(s) {
  const total = s.segments.reduce((n, x) => n + x.weight, 0);
  return { ...s, segments: s.segments.map((x) => ({ ...x, chancePercent: Math.round((x.weight / total) * 10000) / 100 })), note: NOTE };
}

router.get('/spin-segments', async (_req, res) => {
  res.json(segmentsView(await dailySpin.getSegments()));
});

// Replaces the whole wheel (2–12 segments, in wheel order). Spins already made keep what they won.
const segmentsSchema = z.object({
  segments: z.array(z.object({
    label: z.string().trim().min(1).max(40).optional(),
    sparks: z.number().int().min(1).max(dailySpin.MAX_SEGMENT_SPARKS),
    weight: z.number().int().min(1).max(dailySpin.MAX_WEIGHT),
  })).min(dailySpin.MIN_SEGMENTS).max(dailySpin.MAX_SEGMENTS),
});
router.put('/spin-segments', validate(segmentsSchema), async (req, res) => {
  const { from, to } = await dailySpin.setSegments(req.body.segments, req.admin.id);
  if (!same(from, to)) await audit(req, 'spin.segments_changed', { entityType: 'spin_segments', details: { from, to } });
  res.json(segmentsView(await dailySpin.getSegments()));
});

router.get('/streak-bonus', async (_req, res) => {
  res.json({ ...(await streak.getAmounts()), note: NOTE + ' Day N adds amounts[N-1]; days after the last use the last amount.' });
});

const amountsSchema = z.object({
  amounts: z.array(z.number().int().min(0).max(streak.MAX_DAY_SPARKS)).min(1).max(streak.MAX_DAYS),
});
router.put('/streak-bonus', validate(amountsSchema), async (req, res) => {
  const { from, to } = await streak.setAmounts(req.body.amounts, req.admin.id);
  if (!same(from, to)) await audit(req, 'streak.amounts_changed', { entityType: 'streak_bonus_amounts', details: { from, to } });
  res.json({ ...(await streak.getAmounts()), note: NOTE });
});

const donateView = (d) => ({ donateUrl: d.value, isDefault: d.isDefault, defaultDonateUrl: config.donateUrl, updatedBy: d.updatedBy, updatedAt: d.updatedAt });

router.get('/donate-url', async (_req, res) => {
  res.json(donateView(await donateUrl()));
});

// Loyadham's official donation page (http(s), at most 255 characters); "" hides the app's Donate button.
const urlSchema = z.object({
  donateUrl: z.union([z.literal(''), z.url({ protocol: /^https?$/ }).max(255)]),
});
router.put('/donate-url', validate(urlSchema), async (req, res) => {
  const before = await donateUrl();
  await writeText('donate_url', req.body.donateUrl, req.admin.id);
  if (before.value !== req.body.donateUrl) {
    await audit(req, 'donate_url.changed', { entityType: 'app_settings', entityId: 'donate_url', details: { from: before.value, to: req.body.donateUrl } });
  }
  res.json(donateView(await donateUrl()));
});

module.exports = router;
