const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const config = require('../config');
const { query, tx } = require('../db');
const validate = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const S = require('../utils/schemas');
const { unauthorized, badRequest, forbidden, conflict, notFound } = require('../utils/errors');
const { accountView, profileView, loadProfiles } = require('../utils/profiles');
const { signAccessToken } = require('../utils/tokens');
const { deleteAccountCompletely } = require('../utils/accountDeletion');
const { authLimiter } = require('../middleware/rateLimit');
const { ageOn, ageGroupForDob } = require('../utils/ageGroup');
const { checkUsername, lowerKey } = require('../utils/usernameFilter');
const { verifyPin } = require('../utils/pin');
const { TZ, etDate, toSql } = require('../utils/time');
const { signupBonusOf } = require('../utils/signupBonus');
const exploreImport = require('../utils/exploreImport');
const referrals = require('../utils/referrals');

/** Private Sign Up details of the account owner (null for accounts created before they were asked). */
const ownerDetails = (a) => ({ firstName: a.first_name || null, lastName: a.last_name || null, gender: a.gender || null });

const router = express.Router();
router.use(requireAuth);

/**
 * Who is playing on this device. profileId = one of the account's profiles, or null for the parent area (parent
 * accounts). The Parent PIN is needed when leaving a child's profile: to a sibling or to the parent area. From the
 * parent area (where a password login starts) picking a child needs no PIN — so the first pick after login is free.
 * Returns a new access token for the chosen profile; the device session (and refresh) keeps it.
 */
router.post('/active-profile', validate(z.object({ profileId: z.number().int().positive().nullable(), pin: S.pin.optional() })), async (req, res) => {
  const a = req.account;
  const target = req.body.profileId;
  let profile = null;
  if (target !== null) {
    profile = (await query('SELECT * FROM profiles WHERE id = ? AND account_id = ?', [target, a.id]))[0];
    if (!profile) throw notFound('PROFILE_NOT_FOUND', 'Profile not found');
  }
  if (a.account_type !== 'parent') {
    if (!profile) throw forbidden('PARENT_ONLY', 'Only parent accounts have a parent area');
  } else if (req.profileId && req.profileId !== target) {
    if (req.body.pin === undefined) throw unauthorized('PIN_REQUIRED', 'Enter the Parent PIN');
    await verifyPin(a, req.body.pin);
  }
  await query('UPDATE refresh_tokens SET profile_id = ? WHERE session_id = ? AND account_id = ? AND revoked_at IS NULL', [target, req.sessionId, a.id]);
  res.json({
    accessToken: signAccessToken(a, target, req.sessionId),
    activeProfileId: target,
    profile: profile ? profileView(profile, { own: true }) : null,
  });
});

/**
 * Daily time: the app sends a beat about every 60 s while a profile is active and the app is in the foreground, and
 * queues beats while offline (at most 1 day back). Each beat counts once per profile per UTC minute (retries are
 * harmless, nobody can count more than real time) and is added to the America/New_York day it happened in.
 */
const beatSchema = z.object({
  beats: z.array(z.object({
    at: z.string().max(40).refine((s) => !Number.isNaN(Date.parse(s)), 'Use an ISO 8601 time'),
    seconds: z.number().int().min(1).max(60),
  })).min(1).max(1500),
});
router.post('/activity/heartbeat', validate(beatSchema), async (req, res) => {
  if (!req.profileId) throw forbidden('NO_ACTIVE_PROFILE', 'No profile is active on this device');
  const now = Date.now();
  let counted = 0, ignored = 0;
  for (const b of req.body.beats) {
    const t = Date.parse(b.at);
    if (t > now + 2 * 60000 || t < now - 86400000) { ignored++; continue; }   // future, or older than 1 day
    const minute = new Date(Math.floor(t / 60000) * 60000);
    const r = await query('INSERT IGNORE INTO profile_activity_minutes (profile_id, minute_start, seconds) VALUES (?,?,?)',
      [req.profileId, toSql(minute), b.seconds]);
    if (!r.affectedRows) { ignored++; continue; }   // this minute was already counted
    await query(
      `INSERT INTO profile_daily_activity (profile_id, game_day, active_seconds) VALUES (?,?,?)
       ON DUPLICATE KEY UPDATE active_seconds = LEAST(active_seconds + VALUES(active_seconds), 86400)`,
      [req.profileId, etDate(minute), b.seconds]);
    counted++;
  }
  await query('DELETE FROM profile_activity_minutes WHERE profile_id = ? AND minute_start < ?', [req.profileId, toSql(new Date(now - 2 * 86400000))]);
  res.json({ counted, ignored });
});

/** The calendar days from `days - 1` days before `today` up to `today` (YYYY-MM-DD, no time-zone arithmetic). */
function lastDays(today, days) {
  const [y, m, d] = today.split('-').map(Number);
  return Array.from({ length: days }, (_, i) => new Date(Date.UTC(y, m - 1, d - (days - 1 - i))).toISOString().slice(0, 10));
}

// A child's daily time for the parent area (oldest day first, missing days = 0). Parent accounts, parent area only.
router.get('/children/:id/activity', validate(z.object({ id: z.coerce.number().int().positive() }), 'params'),
  validate(z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }), 'query'), async (req, res) => {
    if (req.account.account_type !== 'parent') throw forbidden('PARENT_ONLY', 'Only parent accounts can do this');
    if (req.profileId) throw forbidden('PARENT_MODE_REQUIRED', 'Switch to the parent area first');
    const id = req.validated.params.id;
    const kid = (await query('SELECT id FROM profiles WHERE id = ? AND account_id = ? AND is_child = 1', [id, req.account.id]))[0];
    if (!kid) throw notFound('PROFILE_NOT_FOUND', 'Profile not found');
    const today = etDate();
    const days = lastDays(today, req.validated.query.days);
    const rows = await query('SELECT game_day, active_seconds FROM profile_daily_activity WHERE profile_id = ? AND game_day BETWEEN ? AND ?',
      [id, days[0], today]);
    const byDay = new Map(rows.map((r) => [String(r.game_day).slice(0, 10), r.active_seconds]));
    const list = days.map((day) => {
      const seconds = byDay.get(day) || 0;
      return { day, seconds, minutes: Math.floor(seconds / 60) };
    });
    const t = list[list.length - 1];
    res.json({ profileId: id, timeZone: TZ, today, todaySeconds: t.seconds, todayMinutes: t.minutes, days: list });
  });

// The owner's own view: also the private Sign Up details (name, gender) and the reserved sign-up bonus. These are
// returned here only (never in login/refresh responses, other users' views or admin lists), and never logged.
router.get('/', async (req, res) => {
  const profiles = await loadProfiles(req.account.id);
  res.json({
    account: { ...accountView(req.account), ...ownerDetails(req.account), signupBonus: await signupBonusOf(req.account.id) },
    profiles: profiles.map((p) => profileView(p, { own: true })), activeProfileId: req.profileId,
  });
});

// Account settings. A parent account's settings change only in the parent area, never from a child's session.
router.patch('/', validate(z.object({ phone: S.phone.nullable().optional(), language: S.language.optional() })), async (req, res) => {
  if (req.account.account_type === 'parent' && req.profileId) throw forbidden('PARENT_MODE_REQUIRED', 'Switch to the parent area first');
  const { phone, language } = req.body;
  if (phone !== undefined) await query('UPDATE accounts SET phone = ? WHERE id = ?', [phone, req.account.id]);
  if (language) await query('UPDATE accounts SET preferred_language = ? WHERE id = ?', [language, req.account.id]);
  const a = (await query('SELECT * FROM accounts WHERE id = ?', [req.account.id]))[0];
  res.json({ account: accountView(a) });
});

/**
 * Independent accounts create their own playable profile after verifying their email (Part 6 "Profile setup").
 * Uses the date of birth given at registration (then removes it from the account: it lives on the profile only),
 * and makes the new profile active on this device session.
 */
router.post('/profile', validate(z.object({ username: S.username, avatarId: S.avatarId, mode: S.mode.optional(), country: S.country.optional(), contentLanguage: S.language.optional() })), async (req, res) => {
  const a = req.account;
  if (a.account_type !== 'adult') throw forbidden('INDEPENDENT_ONLY', 'Parent accounts add child profiles with POST /profiles');
  if ((await query('SELECT 1 FROM profiles WHERE account_id = ? LIMIT 1', [a.id])).length) throw conflict('PROFILE_EXISTS', 'This account already has a profile');
  if (!a.dob) throw badRequest('DOB_MISSING', 'This account has no date of birth on file');
  // checked at registration; checked again in case the consent age setting changed since
  if (ageOn(a.dob) < config.parentalConsentAge) throw badRequest('PARENT_ACCOUNT_REQUIRED', 'Please ask a parent to create a Parent account for you.');
  const u = await checkUsername(req.body.username);
  if (!u.ok) throw badRequest('USERNAME_' + u.reason, 'That username cannot be used');

  const { username, avatarId, mode, country, contentLanguage } = req.body;
  const profileId = await tx(async (c) => {
    const r = await c.query(
      `INSERT INTO profiles (account_id, username, username_lower, avatar_id, dob, age_group, is_child, language, content_language, mode, country)
       VALUES (?,?,?,?,?,?,0,?,?,?,?)`,
      [a.id, username.normalize('NFC'), lowerKey(username), avatarId, a.dob, ageGroupForDob(a.dob), a.preferred_language,
        contentLanguage || a.preferred_language, mode || null, country || null]);
    await c.query('UPDATE accounts SET dob = NULL WHERE id = ?', [a.id]);
    // this device session now plays as the new profile (refresh keeps it)
    await c.query('UPDATE refresh_tokens SET profile_id = ? WHERE session_id = ? AND account_id = ? AND revoked_at IS NULL', [r.insertId, req.sessionId, a.id]);
    return r.insertId;
  });
  const p = (await query('SELECT * FROM profiles WHERE id = ?', [profileId]))[0];
  res.status(201).json({
    accessToken: signAccessToken(a, profileId, req.sessionId),
    activeProfileId: profileId,
    profile: profileView(p, { own: true }),
  });
});

/**
 * Explore → account (client, 30 Oct 2026): what someone earned and did in Explore mode goes into their new profile
 * (an independent account's own profile, or a parent's child named by profileId, from the parent area). Once per
 * account, idempotent by transaction id; entries wait as 'pending_import' until Milestone 2/3 verifies and credits
 * them. Rules: utils/exploreImport.js.
 */
router.post('/explore-import', validate(exploreImport.schema), async (req, res) => {
  res.json(await tx((c) => exploreImport.importExplore(c, req)));
});

/**
 * Referrals (contract 8.3, client rules 30 Oct 2026; rules in utils/referrals.js). The code belongs to the account.
 * GET: my code, how many friends used it (no names) and the code this account used. Codes are never logged.
 */
router.get('/referral', async (req, res) => {
  res.json(await referrals.referralView(req.account));
});

// Apply a friend's code (once per account, within the window). A parent applies it from the parent area.
// deviceId: the app's random install id (optional), only used to refuse a second referral from the same phone.
router.post('/referral/apply', authLimiter, validate(z.object({ code: z.string().trim().min(1).max(20), deviceId: z.string().trim().min(8).max(100).optional() })), async (req, res) => {
  requireParentAreaIfParent(req);
  const applied = await tx((c) => referrals.applyReferral(c, req.account, req.body.code, req.body.deviceId));
  res.json({ applied, referral: await referrals.referralView(req.account) });
});

/** A parent account playing as a child: account settings, password and deletion belong to the parent area. */
function requireParentAreaIfParent(req) {
  if (req.account.account_type === 'parent' && req.profileId) throw forbidden('PARENT_MODE_REQUIRED', 'Switch to the parent area first');
}

/**
 * Settings for whoever is playing (contract 3.1: language and mode can change at any time).
 * - Independent: language (the app language) → the account and its profile; contentLanguage (questions, games,
 *   PDFs, learning content; client, 3 Nov 2026), mode and country → its profile.
 * - Parent area (no active profile): language → the account; there is no path or country to set (400 NO_ACTIVE_PROFILE).
 * - A parent's child: refused (403 PARENT_MODE_REQUIRED); the parent sets a child's path, language and country in
 *   Edit child (PATCH /profiles/:id).
 */
router.patch('/settings', validate(z.object({ language: S.language.optional(), contentLanguage: S.language.optional(), mode: S.mode.nullable().optional(), country: S.country.optional() })
  .refine((b) => b.language !== undefined || b.contentLanguage !== undefined || b.mode !== undefined || b.country !== undefined, 'Send language, contentLanguage, mode and/or country')), async (req, res) => {
  requireParentAreaIfParent(req);
  const { language, contentLanguage, mode, country } = req.body;
  if ((mode !== undefined || country !== undefined || contentLanguage !== undefined) && !req.profileId) throw badRequest('NO_ACTIVE_PROFILE', 'No profile is active on this device');
  await tx(async (c) => {
    if (language) await c.query('UPDATE accounts SET preferred_language = ? WHERE id = ?', [language, req.account.id]);
    if (req.profileId && language) await c.query('UPDATE profiles SET language = ? WHERE id = ? AND account_id = ?', [language, req.profileId, req.account.id]);
    if (req.profileId && contentLanguage) await c.query('UPDATE profiles SET content_language = ? WHERE id = ? AND account_id = ?', [contentLanguage, req.profileId, req.account.id]);
    if (req.profileId && mode !== undefined) await c.query('UPDATE profiles SET mode = ? WHERE id = ? AND account_id = ?', [mode, req.profileId, req.account.id]);
    if (req.profileId && country !== undefined) await c.query('UPDATE profiles SET country = ? WHERE id = ? AND account_id = ?', [country, req.profileId, req.account.id]);
  });
  const a = (await query('SELECT * FROM accounts WHERE id = ?', [req.account.id]))[0];
  const p = req.profileId ? (await query('SELECT * FROM profiles WHERE id = ?', [req.profileId]))[0] : null;
  res.json({ account: accountView(a), profile: p ? profileView(p, { own: true }) : null });
});

/**
 * Change the password (contract 3.5). Every OTHER device is logged out; this device stays logged in: the token
 * version moves on (so every old access token stops working) and this session gets a new access token. Its
 * refresh token stays valid.
 */
router.post('/password', authLimiter, validate(z.object({ currentPassword: z.string().min(1), newPassword: S.password })), async (req, res) => {
  requireParentAreaIfParent(req);
  if (!(await bcrypt.compare(req.body.currentPassword, req.account.password_hash))) throw unauthorized('INVALID_CREDENTIALS', 'Current password is incorrect');
  const hash = await bcrypt.hash(req.body.newPassword, config.bcryptRounds);
  const ended = await tx(async (c) => {
    await c.query('UPDATE accounts SET password_hash = ?, token_version = token_version + 1 WHERE id = ?', [hash, req.account.id]);
    const r = await c.query('UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP() WHERE account_id = ? AND session_id <> ? AND revoked_at IS NULL',
      [req.account.id, req.sessionId || '']);
    return r.affectedRows || 0;
  });
  const account = (await query('SELECT * FROM accounts WHERE id = ?', [req.account.id]))[0];
  res.json({ accessToken: signAccessToken(account, req.profileId, req.sessionId), activeProfileId: req.profileId, otherSessionsEnded: ended });
});

/**
 * Delete the account now (contract 3.4), after the password check. Everything goes in one transaction: the account,
 * every profile (a parent's children too) and their data, and every session on every device. A completed row is
 * kept in the deletion history (source app; ids and counts only). The public web page still files a request that a
 * Full Admin approves.
 */
router.delete('/', authLimiter, validate(z.object({ password: z.string().min(1), confirm: z.literal(true) })), async (req, res) => {
  requireParentAreaIfParent(req);
  if (!(await bcrypt.compare(req.body.password, req.account.password_hash))) throw unauthorized('INVALID_CREDENTIALS', 'Password is incorrect');
  const { profilesDeleted } = await tx((c) => deleteAccountCompletely(c, req.account, { source: 'app' }));
  res.json({ deleted: true, profilesDeleted });
});

module.exports = router;
