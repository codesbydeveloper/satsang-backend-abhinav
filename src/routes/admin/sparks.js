const express = require('express');
const { z } = require('zod');
const validate = require('../../middleware/validate');
const { requireAdmin, requireRole } = require('../../middleware/adminAuth');
const { audit } = require('../../utils/audit');
const { AGE_GROUP_KEYS } = require('../../utils/ageGroup');
const sparks = require('../../services/sparks');

// Sparks reward config (Milestone 2, contract 8.1): Sparks per activity AND per age group, changed here without an
// app release. Full Admin only. Seeded values are defaults to be confirmed by Loyadham (isDefault: true).
const router = express.Router();
router.use(requireAdmin, requireRole('full_admin'));

router.get('/config', async (_req, res) => {
  res.json(await sparks.getRewardConfig());
});

// Partial update: only the rows sent change. Audited "sparks.config_changed" with each change (from → to).
const putSchema = z.object({
  rewards: z.array(z.object({
    activity: z.enum(sparks.REWARD_ACTIVITIES),
    ageGroup: z.enum(AGE_GROUP_KEYS),
    sparks: z.number().int().min(0).max(sparks.MAX_REWARD),
  })).min(1).max(sparks.REWARD_ACTIVITIES.length * AGE_GROUP_KEYS.length)
    .refine((list) => new Set(list.map((r) => `${r.activity}|${r.ageGroup}`)).size === list.length, 'Each activity + age group only once'),
});
router.put('/config', validate(putSchema), async (req, res) => {
  const changed = await sparks.setRewardConfig(req.body.rewards, req.admin.id);
  if (changed.length) await audit(req, 'sparks.config_changed', { entityType: 'sparks_reward_config', details: { changes: changed } });
  res.json({ changed, ...(await sparks.getRewardConfig()) });
});

module.exports = router;
