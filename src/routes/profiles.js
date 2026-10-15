const express = require('express');
const { z } = require('zod');
const config = require('../config');
const { query } = require('../db');
const validate = require('../middleware/validate');
const { requireAuth, requireParent } = require('../middleware/auth');
const S = require('../utils/schemas');
const { badRequest, notFound, forbidden, conflict } = require('../utils/errors');
const { verifyPin } = require('../utils/pin');
const { checkUsername, lowerKey } = require('../utils/usernameFilter');
const { ageOn, ageGroupForDob } = require('../utils/ageGroup');
const { profileView, loadProfiles } = require('../utils/profiles');
const { signAccessToken } = require('../utils/tokens');
const { etDate } = require('../utils/time');

const router = express.Router();
router.use(requireAuth);

const idParam = z.object({ id: z.coerce.number().int().positive() });
async function ownedProfile(req) {
  const p = (await query('SELECT * FROM profiles WHERE id = ? AND account_id = ?', [req.validated.params.id, req.account.id]))[0];
  if (!p) throw notFound('PROFILE_NOT_FOUND', 'Profile not found');
  return p;
}

router.get('/', async (req, res) => {
  const profiles = await loadProfiles(req.account.id);
  res.json({ profiles: profiles.map((p) => profileView(p, { own: true })), activeProfileId: req.profileId });
});


// The app calls this every ~60s while a profile is actively in use. The server adds the seconds to today's
// (Eastern Time) total, capped per call so a buggy or tampered client cannot invent hours of play.
router.post('/activity', validate(z.object({ seconds: z.number().int().min(1).max(300) })), async (req, res) => {
  if (!req.profileId) throw forbidden('NO_ACTIVE_PROFILE', 'No profile is active on this device');
  await query(
    `INSERT INTO profile_daily_activity (profile_id, game_day, active_seconds) VALUES (?,?,?)
     ON DUPLICATE KEY UPDATE active_seconds = LEAST(active_seconds + VALUES(active_seconds), 86400)`,
    [req.profileId, etDate(), req.body.seconds]);
  res.json({ ok: true });
});

// Add a child profile (parent accounts). Protected by the Parent PIN and a recorded parental consent.
const createSchema = z.object({
  pin: S.pin, username: S.username, avatarId: S.avatarId, dob: S.dob,
  language: S.language.optional(), mode: S.mode.optional(),
  parentalConsent: z.literal(true, { error: 'Parental consent is required to create a child profile' }),
});
router.post('/', requireParent, validate(createSchema), async (req, res) => {
  const b = req.body;
  await verifyPin(req.account, b.pin);
  const age = ageOn(b.dob);
  if (age > 18) throw badRequest('CHILD_TOO_OLD', 'Child profiles are for ages 18 and under. Older users register their own account.');
  const u = await checkUsername(b.username);
  if (!u.ok) throw badRequest('USERNAME_' + u.reason, 'That username cannot be used');

  const r = await query(
    `INSERT INTO profiles (account_id, username, username_lower, avatar_id, dob, age_group, is_child, language, mode, consent_version, consent_at)
     VALUES (?,?,?,?,?,?,1,?,?,?,UTC_TIMESTAMP())`,
    [req.account.id, b.username.normalize('NFC'), lowerKey(b.username), b.avatarId, b.dob, ageGroupForDob(b.dob),
      b.language || req.account.preferred_language, b.mode || null, config.privacyPolicyVersion]);
  const p = (await query('SELECT * FROM profiles WHERE id = ?', [r.insertId]))[0];
  res.status(201).json({ profile: profileView(p, { own: true }) });
});

// Change avatar / language / mode. A parent needs the PIN to edit a child from parent mode;
// a child (or adult) can change these on their own active profile.
const patchSchema = z.object({
  avatarId: S.avatarId.optional(), language: S.language.optional(), mode: S.mode.nullable().optional(), pin: S.pin.optional(),
});
router.patch('/:id', validate(idParam, 'params'), validate(patchSchema), async (req, res) => {
  const p = await ownedProfile(req);
  if (req.account.account_type === 'parent' && req.profileId !== p.id) await verifyPin(req.account, req.body.pin || '');
  const { avatarId, language, mode } = req.body;
  if (avatarId !== undefined) await query('UPDATE profiles SET avatar_id = ? WHERE id = ?', [avatarId, p.id]);
  if (language !== undefined) await query('UPDATE profiles SET language = ? WHERE id = ?', [language, p.id]);
  if (mode !== undefined) await query('UPDATE profiles SET mode = ? WHERE id = ?', [mode, p.id]);
  const fresh = (await query('SELECT * FROM profiles WHERE id = ?', [p.id]))[0];
  res.json({ profile: profileView(fresh, { own: true }) });
});

// Delete one child profile with the Parent PIN; the parent account and sibling profiles are untouched.
router.delete('/:id', requireParent, validate(idParam, 'params'), validate(z.object({ pin: S.pin, confirm: z.literal(true) })), async (req, res) => {
  const p = await ownedProfile(req);
  await verifyPin(req.account, req.body.pin);
  await query('UPDATE refresh_tokens SET profile_id = NULL WHERE account_id = ? AND profile_id = ?', [req.account.id, p.id]);
  await query('DELETE FROM profiles WHERE id = ?', [p.id]);   // cascades to progress, Sparks, items, leaderboard rows
  res.json({ deleted: true });
});

// Switch the device session to a child profile (needs the Parent PIN).
router.post('/:id/switch', requireParent, validate(idParam, 'params'), validate(z.object({ pin: S.pin })), async (req, res) => {
  const p = await ownedProfile(req);
  await verifyPin(req.account, req.body.pin);
  await query('UPDATE refresh_tokens SET profile_id = ? WHERE session_id = ? AND revoked_at IS NULL', [p.id, req.sessionId]);
  res.json({ accessToken: signAccessToken(req.account, p.id, req.sessionId), activeProfileId: p.id, profile: profileView(p, { own: true }) });
});

// Leave child mode and return to parent settings (needs the Parent PIN).
router.post('/parent-mode', requireParent, validate(z.object({ pin: S.pin })), async (req, res) => {
  await verifyPin(req.account, req.body.pin);
  await query('UPDATE refresh_tokens SET profile_id = NULL WHERE session_id = ? AND revoked_at IS NULL', [req.sessionId]);
  res.json({ accessToken: signAccessToken(req.account, null, req.sessionId), activeProfileId: null });
});

module.exports = router;
