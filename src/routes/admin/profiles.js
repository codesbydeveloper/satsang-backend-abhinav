const express = require('express');
const { z } = require('zod');
const { tx } = require('../../db');
const validate = require('../../middleware/validate');
const { requireAdmin, requireRole } = require('../../middleware/adminAuth');
const { audit } = require('../../utils/audit');
const { ADMIN_ACTIONS, applyAdminAction } = require('../../utils/studentStatus');

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

module.exports = router;
