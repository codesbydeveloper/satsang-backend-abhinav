// Part 7: Parent PIN (lock, change, reset), switching the active profile, edit child, daily time heartbeats.
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { api, bearer } = h;

beforeEach(h.resetDb);
after(() => h.pool.end());

const addChild = (p, username, years = 8) => api().post('/api/v1/profiles').set(p.auth)
  .send({ username, avatarId: 2, dob: h.dobYearsAgo(years, 30), parentalConsent: true });
const switchTo = (auth, profileId, pin) => api().post('/api/v1/me/active-profile').set(auth).send(pin === undefined ? { profileId } : { profileId, pin });

test('PIN: wrong tries report attempts left; 5 wrong lock it for 5 minutes with retry time; never returned', async () => {
  const p = await h.parentLogin();
  const first = await api().post('/api/v1/parent/pin/verify').set(p.auth).send({ pin: '0000' });
  assert.equal(first.status, 401); assert.equal(first.body.error.code, 'PIN_INCORRECT');
  assert.equal(first.body.error.details.attemptsLeft, 4);
  for (let i = 0; i < 3; i++) await api().post('/api/v1/parent/pin/verify').set(p.auth).send({ pin: '0000' });
  const locked = await api().post('/api/v1/parent/pin/verify').set(p.auth).send({ pin: '0000' });
  assert.equal(locked.status, 429); assert.equal(locked.body.error.code, 'PIN_LOCKED');
  assert.ok(locked.body.error.details.retryAfterSeconds > 240 && locked.body.error.details.retryAfterSeconds <= 300);
  const row = (await h.query('SELECT parent_pin_hash, pin_locked_until FROM accounts'))[0];
  assert.match(row.parent_pin_hash, /^\$2[aby]\$/, 'stored as bcrypt');
  const me = await api().get('/api/v1/me').set(p.auth);
  assert.equal(JSON.stringify(me.body).includes('pin_hash') || JSON.stringify(me.body).includes('1234'), false);
  assert.equal(me.body.account.parentPinSet, true);
});

test('PIN change needs the current PIN; reset needs the password; neither logs the parent out', async () => {
  const p = await h.parentLogin();
  assert.equal((await api().post('/api/v1/parent/pin/change').set(p.auth).send({ currentPin: '9999', newPin: '5555' })).status, 401);
  assert.equal((await api().post('/api/v1/parent/pin/change').set(p.auth).send({ currentPin: '1234', newPin: '5555' })).status, 200);
  assert.equal((await api().post('/api/v1/parent/pin/verify').set(p.auth).send({ pin: '5555' })).status, 200);
  assert.equal((await api().post('/api/v1/parent/pin/reset').set(p.auth).send({ password: 'nope', newPin: '7777' })).status, 401);
  assert.equal((await api().post('/api/v1/parent/pin/reset').set(p.auth).send({ password: 'Secret123', newPin: '7777' })).status, 200);
  // same access token and refresh token still work
  assert.equal((await api().get('/api/v1/me').set(p.auth)).status, 200);
  assert.equal((await api().post('/api/v1/auth/refresh').send({ refreshToken: p.refreshToken })).status, 200);
});

test('switch: first pick after login needs no PIN; child → child and child → parent area need it', async () => {
  const p = await h.parentLogin();
  const a = (await addChild(p, 'child_aaa')).body.profile;
  const b = (await addChild(p, 'child_bbb')).body.profile;

  const pick = await switchTo(p.auth, a.id);                       // from the parent area: no PIN
  assert.equal(pick.status, 200, JSON.stringify(pick.body));
  assert.equal(pick.body.activeProfileId, a.id);
  assert.equal(pick.body.profile.username, 'child_aaa');
  const asA = bearer(pick.body.accessToken);
  assert.equal((await api().get('/api/v1/me').set(asA)).body.activeProfileId, a.id);

  assert.equal((await switchTo(asA, a.id)).status, 200, 'staying on the same profile needs no PIN');
  const noPin = await switchTo(asA, b.id);
  assert.equal(noPin.status, 401); assert.equal(noPin.body.error.code, 'PIN_REQUIRED');
  assert.equal((await switchTo(asA, b.id, '0000')).body.error.code, 'PIN_INCORRECT');
  const toB = await switchTo(asA, b.id, '1234');
  assert.equal(toB.body.activeProfileId, b.id);
  const asB = bearer(toB.body.accessToken);

  assert.equal((await switchTo(asB, null)).body.error.code, 'PIN_REQUIRED');
  const parentArea = await switchTo(asB, null, '1234');
  assert.equal(parentArea.status, 200);
  assert.equal(parentArea.body.activeProfileId, null);
  assert.equal(parentArea.body.profile, null);
  // the session keeps the choice across a refresh
  assert.equal((await api().post('/api/v1/auth/refresh').send({ refreshToken: p.refreshToken })).body.activeProfileId, null);

  // another account's profile, and adults asking for a parent area
  const other = await h.parentLogin('other@example.org');
  assert.equal((await switchTo(other.auth, a.id)).status, 404);
  const adult = await h.adultLogin();
  assert.equal((await switchTo(bearer(adult.accessToken), null)).body.error.code, 'PARENT_ONLY');
  assert.equal((await switchTo(bearer(adult.accessToken), adult.profiles[0].id)).status, 200);
});

test('edit child: username / avatar / path from the parent area; a child cannot rename itself', async () => {
  const p = await h.parentLogin();
  const a = (await addChild(p, 'child_aaa')).body.profile;
  const b = (await addChild(p, 'child_bbb')).body.profile;
  const r = await api().patch(`/api/v1/profiles/${a.id}`).set(p.auth).send({ username: 'Star_Child', avatarId: 12, mode: 'satsang' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.profile.username, 'Star_Child');
  assert.equal(r.body.profile.avatarId, 12);
  assert.equal(r.body.profile.mode, 'satsang');
  assert.equal((await api().patch(`/api/v1/profiles/${a.id}`).set(p.auth).send({ username: 'star_child' })).status, 200, 'own name, other case');
  assert.equal((await api().patch(`/api/v1/profiles/${a.id}`).set(p.auth).send({ username: 'CHILD_BBB' })).body.error.code, 'USERNAME_TAKEN');

  const asA = bearer((await switchTo(p.auth, a.id)).body.accessToken);
  assert.equal((await api().patch(`/api/v1/profiles/${a.id}`).set(asA).send({ username: 'renamed_me' })).body.error.code, 'USERNAME_PARENT_ONLY');
  assert.equal((await api().patch(`/api/v1/profiles/${a.id}`).set(asA).send({ avatarId: 3 })).status, 200, 'own avatar is fine');
  assert.equal((await api().patch(`/api/v1/profiles/${b.id}`).set(asA).send({ avatarId: 3 })).status, 401, 'sibling needs the PIN');
  assert.equal((await api().patch(`/api/v1/profiles/${b.id}`).set(asA).send({ avatarId: 3, pin: '1234' })).status, 200);
  // adding a child from a child's session is refused
  assert.equal((await api().post('/api/v1/profiles').set(asA).send({ username: 'third_kid', avatarId: 1, dob: h.dobYearsAgo(6), parentalConsent: true })).body.error.code, 'PARENT_MODE_REQUIRED');
});

test('daily time: beats count once per minute, into the Eastern day, up to 1 day back; parents read 7 days', async () => {
  const p = await h.parentLogin();
  const a = (await addChild(p, 'child_aaa')).body.profile;
  // no active profile → refused
  assert.equal((await api().post('/api/v1/me/activity/heartbeat').set(p.auth).send({ beats: [{ at: new Date().toISOString(), seconds: 60 }] })).status, 403);
  const asA = bearer((await switchTo(p.auth, a.id)).body.accessToken);

  const now = Date.now();
  const at = (minutesAgo) => new Date(now - minutesAgo * 60000).toISOString();
  const first = await api().post('/api/v1/me/activity/heartbeat').set(asA).send({ beats: [{ at: at(3), seconds: 60 }, { at: at(2), seconds: 60 }, { at: at(1), seconds: 45 }] });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(first.body, { counted: 3, ignored: 0 });
  // an offline queue retrying the same beats, plus one too old and one in the future
  const again = await api().post('/api/v1/me/activity/heartbeat').set(asA).send({ beats: [{ at: at(3), seconds: 60 }, { at: at(2), seconds: 60 }, { at: at(60 * 25), seconds: 60 }, { at: at(-10), seconds: 60 }] });
  assert.deepEqual(again.body, { counted: 0, ignored: 4 });
  assert.equal((await api().post('/api/v1/me/activity/heartbeat').set(asA).send({ beats: [{ at: at(0), seconds: 61 }] })).status, 400);
  assert.equal((await api().post('/api/v1/me/activity/heartbeat').set(asA).send({ beats: [{ at: 'yesterday', seconds: 60 }] })).status, 400);

  // the child cannot read it; the parent area can
  assert.equal((await api().get(`/api/v1/me/children/${a.id}/activity`).set(asA)).body.error.code, 'PARENT_MODE_REQUIRED');
  const back = bearer((await switchTo(asA, null, '1234')).body.accessToken);
  const r = await api().get(`/api/v1/me/children/${a.id}/activity`).set(back);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.timeZone, 'America/New_York');
  assert.equal(r.body.days.length, 7);
  assert.equal(r.body.days[6].day, r.body.today, 'oldest first, today last');
  const total = r.body.days.reduce((t, d) => t + d.seconds, 0);
  assert.equal(total, 165);
  assert.equal(r.body.days.filter((d) => d.seconds === 0).length >= 5, true);
  assert.equal((await api().get(`/api/v1/me/children/${a.id}/activity`).set(back).query({ days: 30 })).body.days.length, 30);
  assert.equal((await api().get(`/api/v1/me/children/${a.id}/activity`).set(back).query({ days: 0 })).status, 400);

  const other = await h.parentLogin('other@example.org');
  assert.equal((await api().get(`/api/v1/me/children/${a.id}/activity`).set(other.auth)).status, 404);
  const adult = await h.adultLogin();
  assert.equal((await api().get(`/api/v1/me/children/${a.id}/activity`).set(bearer(adult.accessToken))).body.error.code, 'PARENT_ONLY');
});

test('/api-docs.json documents the Part 7 endpoints', async () => {
  const r = await api().get('/api-docs.json');
  for (const path of ['/me/active-profile', '/me/activity/heartbeat', '/me/children/{id}/activity', '/parent/pin/change']) assert.ok(r.body.paths[path], path);
});
