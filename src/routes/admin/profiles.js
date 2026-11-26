const express = require('express');
const { z } = require('zod');
const { query, tx } = require('../../db');
const validate = require('../../middleware/validate');
const { requireAdmin, requireRole } = require('../../middleware/adminAuth');
const { audit } = require('../../utils/audit');
const { ADMIN_ACTIONS, applyAdminAction } = require('../../utils/studentStatus');
const { notFound } = require('../../utils/errors');
const sparks = require('../../services/sparks');

const router = express.Router();
router.use(requireAdmin, requireRole('full_admin'));   // user data is Full Admin only

// Verify / reject an enrolment, confirm an interest, or reset a profile's student status (rules in utils/studentStatus).
// Sparks (verify, confirm_interest) go to this profile, at most once per reward. Audited with the profile id only.
router.post('/:id/student-status', validate(z.object({ id: z.coerce.number().int().positive() }), 'params'),
  validate(z.object({ action: z.enum(ADMIN_ACTIONS) })), async (req, res) => {
    const profileId = req.validated.params.id;
    const r = await tx((c) => applyAdminAction(c, profileId, req.body.action, req.admin.id));
    await audit(req, r.auditAction, { entityType: 'profile', entityId: profileId, details: { from: r.from, to: r.to, sparksAwarded: r.sparksAwarded } });
    res.json({ profileId, studentStatus: r.to, previousStatus: r.from, sparksAwarded: r.sparksAwarded, studentSparksAwarded: r.studentSparksAwarded });
  });

// ---- Sparks (Milestone 2, contract 8.1): one playable profile's balance, history and manual adjustments ----

const idParam = z.object({ id: z.coerce.number().int().positive() });
async function profileOr404(id) {
  const p = (await query('SELECT id, account_id, username, is_child FROM profiles WHERE id = ?', [id]))[0];
  if (!p) throw notFound('PROFILE_NOT_FOUND', 'Profile not found');
  return p;
}
const who = (p) => ({ profileId: Number(p.id), accountId: Number(p.account_id), username: p.username, isChild: !!p.is_child });

router.get('/:id/sparks', validate(idParam, 'params'), async (req, res) => {
  const p = await profileOr404(req.validated.params.id);
  res.json({ ...who(p), ...(await sparks.getBalance(p.id)) });
});

const historyQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(['verified', 'pending', 'reversed']).optional(),
  type: z.enum(sparks.TYPES).optional(),
});
router.get('/:id/sparks/history', validate(idParam, 'params'), validate(historyQuery, 'query'), async (req, res) => {
  const p = await profileOr404(req.validated.params.id);
  const h = await sparks.getHistory(p.id, req.validated.query);
  res.json({ ...who(p), ...h, items: h.items.map(sparks.txView) });
});

// Add (amount > 0) or deduct (amount < 0) Sparks with a required reason. A deduction never takes the balance below
// zero (409 INSUFFICIENT_SPARKS). transactionId (optional) makes a retried click safe. Audited "sparks.adjusted".
const adjustSchema = z.object({
  amount: z.number().int().min(-sparks.MAX_AMOUNT).max(sparks.MAX_AMOUNT).refine((n) => n !== 0, 'amount cannot be 0'),
  reason: z.string().trim().min(3).max(255),
  transactionId: z.string().trim().min(1).max(64).optional(),
});
router.post('/:id/sparks/adjust', validate(idParam, 'params'), validate(adjustSchema), async (req, res) => {
  const p = await profileOr404(req.validated.params.id);
  const { amount, reason, transactionId } = req.body;
  const r = await sparks.adjust({ profileId: p.id, amount, note: reason, transactionId, createdBy: req.admin.id, reference: `admin:${req.admin.id}` });
  if (!r.duplicate) {
    await audit(req, 'sparks.adjusted', { entityType: 'profile', entityId: p.id,
      details: { amount, reason, transactionId: r.transaction.transaction_id, balanceAfter: r.balance.balance } });
  }
  res.status(r.duplicate ? 200 : 201).json({ duplicate: r.duplicate, transaction: sparks.txView(r.transaction), ...who(p), ...r.balance });
});

module.exports = router;
