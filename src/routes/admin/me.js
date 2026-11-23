const express = require('express');
const { z } = require('zod');
const validate = require('../../middleware/validate');
const { requireAdmin } = require('../../middleware/adminAuth');
const { notFound } = require('../../utils/errors');
const { listDevices, revokeDevice } = require('../../utils/adminSessions');

// The signed-in admin's own trusted devices (any role).
const router = express.Router();
router.use(requireAdmin);

router.get('/devices', async (req, res) => {
  res.json({ devices: await listDevices(req.admin.id) });
});

// Revoke one of your own trusted devices: the next login there needs the emailed code again.
router.delete('/devices/:id', validate(z.object({ id: z.coerce.number().int().positive() }), 'params'), async (req, res) => {
  if (!(await revokeDevice(req, req.admin.id, req.validated.params.id, 'self'))) throw notFound('DEVICE_NOT_FOUND', 'Trusted device not found');
  res.json({ ok: true, revoked: true });
});

module.exports = router;
