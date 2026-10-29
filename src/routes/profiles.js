const express = require('express');
const { z } = require('zod');
const config = require('../config');
const { query, tx } = require('../db');
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
const { deleteChildProfile } = require('../utils/accountDeletion');

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

/**
 * Parent-area guard for managing child profiles. The parent area is a session in parent mode (no active profile):
 * reached by a password login or by entering the PIN (POST /me/active-profile), so it needs no PIN per request.
 * A PIN sent anyway is checked. From a child's session the PIN is required.
 */
async function requireParentArea(req, pin) {
  if (pin !== undefined) return verifyPin(req.account, pin);
  if (req.profileId) throw forbidden('PARENT_MODE_REQUIRED', 'Switch to the parent area first (Parent PIN)');
}

// Add a child profile (parent accounts, parent area) with a recorded parental consent. The first child may be added
// before the Parent PIN exists (the app asks for the PIN right after); later children need the PIN to be set.
const createSchema = z.object({
  pin: S.pin.optional(), username: S.username, avatarId: S.avatarId, dob: S.dob,
  language: S.language.optional(), mode: S.mode.optional(), country: S.country.optional(),
  parentalConsent: z.literal(true, { error: 'Parental consent is required to create a child profile' }),
});
router.post('/', requireParent, validate(createSchema), async (req, res) => {
  const b = req.body;
  await requireParentArea(req, b.pin);
  if (!req.account.parent_pin_hash && (await query('SELECT 1 FROM profiles WHERE account_id = ? LIMIT 1', [req.account.id])).length) {
    throw conflict('PIN_NOT_SET', 'Create a Parent PIN first');
  }
  const age = ageOn(b.dob);
  if (age > 18) throw badRequest('CHILD_TOO_OLD', 'Child profiles are for ages 18 and under. Older users register their own account.');
  const u = await checkUsername(b.username);
  if (!u.ok) throw badRequest('USERNAME_' + u.reason, 'That username cannot be used');

  const r = await query(
    `INSERT INTO profiles (account_id, username, username_lower, avatar_id, dob, age_group, is_child, language, mode, country, consent_version, consent_at)
     VALUES (?,?,?,?,?,?,1,?,?,?,?,UTC_TIMESTAMP())`,
    [req.account.id, b.username.normalize('NFC'), lowerKey(b.username), b.avatarId, b.dob, ageGroupForDob(b.dob),
      b.language || req.account.preferred_language, b.mode || null, b.country || null, config.privacyPolicyVersion]);
  const p = (await query('SELECT * FROM profiles WHERE id = ?', [r.insertId]))[0];
  res.status(201).json({ profile: profileView(p, { own: true }) });
});

// Change username / avatar / language / mode / country.
// - Parent in the parent area: any of their children, no PIN (the area itself is PIN-protected).
// - Parent session playing as one child, editing a sibling: PIN required.
// - The active profile itself: an adult changes avatar / language / mode / country; a parent's child only its avatar.
//   A child's path, language, country and username are sensitive settings (contract 3.3): parent area or the Parent PIN.
const patchSchema = z.object({
  username: S.username.optional(), avatarId: S.avatarId.optional(), language: S.language.optional(),
  mode: S.mode.nullable().optional(), country: S.country.optional(), pin: S.pin.optional(),
});
router.patch('/:id', validate(idParam, 'params'), validate(patchSchema), async (req, res) => {
  const p = await ownedProfile(req);
  const isParent = req.account.account_type === 'parent';
  if (isParent && req.profileId && req.profileId !== p.id) await verifyPin(req.account, req.body.pin || '');
  else if (isParent && req.body.pin !== undefined) await verifyPin(req.account, req.body.pin);
  const { username, avatarId, language, mode, country } = req.body;
  if (isParent && req.profileId === p.id && req.body.pin === undefined && (language !== undefined || mode !== undefined || country !== undefined)) {
    throw forbidden('PIN_REQUIRED', "A parent changes this child's path, language and country (Parent PIN)");
  }
  if (username !== undefined) {
    if (!isParent || (req.profileId === p.id && req.body.pin === undefined)) throw forbidden('USERNAME_PARENT_ONLY', 'Only a parent can change this username');
    const u = await checkUsername(username, { excludeProfileId: p.id });
    if (!u.ok) throw badRequest('USERNAME_' + u.reason, 'That username cannot be used');
    await query('UPDATE profiles SET username = ?, username_lower = ? WHERE id = ?', [username.normalize('NFC'), lowerKey(username), p.id]);
  }
  if (avatarId !== undefined) await query('UPDATE profiles SET avatar_id = ? WHERE id = ?', [avatarId, p.id]);
  if (language !== undefined) await query('UPDATE profiles SET language = ? WHERE id = ?', [language, p.id]);
  if (mode !== undefined) await query('UPDATE profiles SET mode = ? WHERE id = ?', [mode, p.id]);
  if (country !== undefined) await query('UPDATE profiles SET country = ? WHERE id = ?', [country, p.id]);
  const fresh = (await query('SELECT * FROM profiles WHERE id = ?', [p.id]))[0];
  res.json({ profile: profileView(fresh, { own: true }) });
});

// Delete one child profile and all its data with the Parent PIN (contract 3.4); the parent account and the other
// children are untouched. From the parent area only. Devices playing as that child are logged out. Nothing about the
// child is logged or kept.
router.delete('/:id', requireParent, validate(idParam, 'params'), validate(z.object({ pin: S.pin, confirm: z.literal(true) })), async (req, res) => {
  if (req.profileId) throw forbidden('PARENT_MODE_REQUIRED', 'Switch to the parent area first');
  const p = await ownedProfile(req);
  if (!p.is_child) throw forbidden('NOT_A_CHILD_PROFILE', 'Only child profiles can be deleted this way');
  await verifyPin(req.account, req.body.pin);
  const sessionsEnded = await tx((c) => deleteChildProfile(c, req.account.id, p.id));   // cascades to all its data
  res.json({ deleted: true, profileId: p.id, sessionsEnded });
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
