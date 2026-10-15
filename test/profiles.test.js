const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { api, bearer } = h;

beforeEach(h.resetDb);
after(() => h.pool.end());

const addChild = (p, over = {}) => api().post('/api/v1/profiles').set(p.auth).send({ pin: '1234', username: 'little_ram', avatarId: 2, dob: h.dobYearsAgo(8, 30), parentalConsent: true, ...over });

test('parent starts in parent mode with no profiles; PIN is required before adding a child', async () => {
  const reg = await api().post('/api/v1/auth/register').send({ email: 'p@example.org', password: 'Secret123', accountType: 'parent', acceptPrivacyPolicy: true, confirmAdult: true });
  assert.equal(reg.status, 201);
  const v = await api().post('/api/v1/auth/verify-email').send({ email: 'p@example.org', code: h.lastCode('p@example.org') });
  assert.equal(v.body.activeProfileId, null);
  assert.equal(v.body.profiles.length, 0);
  assert.equal(v.body.account.parentPinSet, false);
  const noPin = await api().post('/api/v1/profiles').set(bearer(v.body.accessToken)).send({ pin: '1234', username: 'kid_one', avatarId: 1, dob: h.dobYearsAgo(8), parentalConsent: true });
  assert.equal(noPin.status, 409); assert.equal(noPin.body.error.code, 'PIN_NOT_SET');
});

test('parent registration requires confirming 18+ and cannot carry a profile', async () => {
  const a = await api().post('/api/v1/auth/register').send({ email: 'p@example.org', password: 'Secret123', accountType: 'parent', acceptPrivacyPolicy: true });
  assert.equal(a.status, 400);
  const b = await api().post('/api/v1/auth/register').send({ email: 'p@example.org', password: 'Secret123', accountType: 'parent', acceptPrivacyPolicy: true, confirmAdult: true, profile: { username: 'abcd', avatarId: 1, dob: h.dobYearsAgo(40) } });
  assert.equal(b.status, 400);
});

test('child profile: age group from DOB, consent recorded, unique username', async () => {
  const p = await h.parentLogin();
  const c = await addChild(p);
  assert.equal(c.status, 201);
  assert.equal(c.body.profile.ageGroup, 'Bals/Balikas B');   // age 8
  assert.equal(c.body.profile.isChild, true);
  const row = (await h.query('SELECT consent_version, consent_at FROM profiles'))[0];
  assert.ok(row.consent_version && row.consent_at);
  assert.equal((await addChild(p, { username: 'LITTLE_RAM' })).status, 400);                    // same name, other case
  assert.equal((await addChild(p, { username: 'second_kid', parentalConsent: false })).status, 400); // consent required
  assert.equal((await addChild(p, { username: 'old_one', dob: h.dobYearsAgo(25) })).body.error.code, 'CHILD_TOO_OLD');
  assert.equal((await addChild(p, { username: 'bad_pin1', pin: '9999' })).status, 401);
  // a second parent cannot see/touch these profiles
  const other = await h.parentLogin('other@example.org');
  assert.equal((await api().patch(`/api/v1/profiles/${c.body.profile.id}`).set(other.auth).send({ pin: '1234', avatarId: 5 })).status, 404);
});

test('Parent PIN locks after 5 wrong attempts; reset with password unlocks', async () => {
  const p = await h.parentLogin();
  for (let i = 0; i < 4; i++) assert.equal((await api().post('/api/v1/parent/pin/verify').set(p.auth).send({ pin: '0000' })).body.error.code, 'PIN_INCORRECT');
  const fifth = await api().post('/api/v1/parent/pin/verify').set(p.auth).send({ pin: '0000' });
  assert.equal(fifth.status, 429); assert.equal(fifth.body.error.code, 'PIN_LOCKED');
  // even the right PIN is refused while locked
  assert.equal((await api().post('/api/v1/parent/pin/verify').set(p.auth).send({ pin: '1234' })).status, 429);
  assert.equal((await api().post('/api/v1/parent/pin/reset').set(p.auth).send({ password: 'wrong', newPin: '4321' })).status, 401);
  assert.equal((await api().post('/api/v1/parent/pin/reset').set(p.auth).send({ password: 'Secret123', newPin: '4321' })).status, 200);
  assert.equal((await api().post('/api/v1/parent/pin/verify').set(p.auth).send({ pin: '4321' })).status, 200);
  assert.equal((await api().post('/api/v1/parent/pin').set(p.auth).send({ pin: '1111', password: 'Secret123' })).status, 409); // already set
  assert.equal((await api().post('/api/v1/parent/pin/verify').set(p.auth).send({ pin: '12' })).status, 400);
});

test('switching to a child needs the PIN, survives token refresh, and exiting needs the PIN', async () => {
  const p = await h.parentLogin();
  const kid = (await addChild(p)).body.profile;
  assert.equal((await api().post(`/api/v1/profiles/${kid.id}/switch`).set(p.auth).send({ pin: '0000' })).status, 401);
  const sw = await api().post(`/api/v1/profiles/${kid.id}/switch`).set(p.auth).send({ pin: '1234' });
  assert.equal(sw.status, 200);
  assert.equal(sw.body.activeProfileId, kid.id);
  const kidAuth = bearer(sw.body.accessToken);
  assert.equal((await api().get('/api/v1/me').set(kidAuth)).body.activeProfileId, kid.id);

  // refreshing must NOT drop the child back into parent mode
  const rf = await api().post('/api/v1/auth/refresh').send({ refreshToken: p.refreshToken });
  assert.equal(rf.body.activeProfileId, kid.id);
  assert.equal((await api().get('/api/v1/me').set(bearer(rf.body.accessToken))).body.activeProfileId, kid.id);

  // the child can change their own avatar without the PIN, but not another profile
  assert.equal((await api().patch(`/api/v1/profiles/${kid.id}`).set(bearer(rf.body.accessToken)).send({ avatarId: 9 })).body.profile.avatarId, 9);
  const sib = (await addChild(p, { username: 'sibling_1' })).body.profile;
  assert.equal((await api().patch(`/api/v1/profiles/${sib.id}`).set(bearer(rf.body.accessToken)).send({ avatarId: 4 })).status, 401);

  assert.equal((await api().post('/api/v1/profiles/parent-mode').set(bearer(rf.body.accessToken)).send({ pin: '0000' })).status, 401);
  const back = await api().post('/api/v1/profiles/parent-mode').set(bearer(rf.body.accessToken)).send({ pin: '1234' });
  assert.equal(back.body.activeProfileId, null);
  assert.equal((await api().get('/api/v1/me').set(bearer(back.body.accessToken))).body.activeProfileId, null);
});

test('deleting one child profile keeps the parent and siblings; the deleted profile cannot stay active', async () => {
  const p = await h.parentLogin();
  const a = (await addChild(p, { username: 'child_aaa' })).body.profile;
  const b = (await addChild(p, { username: 'child_bbb' })).body.profile;
  await api().post(`/api/v1/profiles/${a.id}/switch`).set(p.auth).send({ pin: '1234' });
  assert.equal((await api().delete(`/api/v1/profiles/${a.id}`).set(p.auth).send({ pin: '0000', confirm: true })).status, 401);
  assert.equal((await api().delete(`/api/v1/profiles/${a.id}`).set(p.auth).send({ pin: '1234', confirm: true })).status, 200);
  const me = await api().get('/api/v1/me').set(p.auth);
  assert.deepEqual(me.body.profiles.map((x) => x.id), [b.id]);
  assert.equal(me.body.activeProfileId, null);               // session fell back to parent mode
  assert.equal(me.body.account.email, 'parent@example.org');
  // the username becomes available again
  assert.equal((await api().get('/api/v1/usernames/check').query({ username: 'child_aaa' })).body.available, true);
});

test('deleting a parent account deletes every child profile', async () => {
  const p = await h.parentLogin();
  await addChild(p, { username: 'child_aaa' }); await addChild(p, { username: 'child_bbb' });
  assert.equal((await h.query('SELECT COUNT(*) n FROM profiles'))[0].n, 2);
  assert.equal((await api().delete('/api/v1/me').set(p.auth).send({ password: 'Secret123', confirm: true })).status, 200);
  assert.equal((await h.query('SELECT COUNT(*) n FROM profiles'))[0].n, 0);
});

test('adult accounts cannot use parent-only endpoints', async () => {
  const s = await h.adultLogin();
  assert.equal((await api().post('/api/v1/parent/pin').set(bearer(s.accessToken)).send({ pin: '1234', password: 'Secret123' })).body.error.code, 'PARENT_ONLY');
  assert.equal((await api().post('/api/v1/profiles').set(bearer(s.accessToken)).send({ pin: '1234', username: 'kid_xyz', avatarId: 1, dob: h.dobYearsAgo(8), parentalConsent: true })).body.error.code, 'PARENT_ONLY');
});

test('stored age group follows the birthday (refreshed on load)', async () => {
  const s = await h.adultLogin();
  // pretend the stored value is stale
  await h.query("UPDATE profiles SET age_group = 'Shishu'");
  const me = await api().get('/api/v1/me').set(bearer(s.accessToken));
  assert.equal(me.body.profiles[0].ageGroup, 'Yuvak/Yuvatis A');
});

test('avatars: exactly 16 (10 animal + 6 human); invalid avatar id rejected', async () => {
  const r = await api().get('/api/v1/avatars');
  assert.equal(r.body.avatars.length, 16);
  assert.equal(r.body.avatars.filter((a) => a.kind === 'animal').length, 10);
  assert.equal(r.body.avatars.filter((a) => a.kind === 'human').length, 6);
  const bad = await api().post('/api/v1/auth/register').send({ email: 'x@example.org', password: 'Secret123', accountType: 'adult', acceptPrivacyPolicy: true, profile: { username: 'xxxx', avatarId: 17, dob: h.dobYearsAgo(30) } });
  assert.equal(bad.status, 400);
});

test('meta config exposes min app version, server time and the Eastern game day', async () => {
  const r = await api().get('/api/v1/meta/config');
  assert.equal(r.body.minAppVersion, '1.0.0');
  assert.equal(r.body.gameTimeZone, 'America/New_York');
  assert.match(r.body.gameDay, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(r.body.ageGroups.length, 9);
});

test('parent report: time heartbeats accumulate per child per Eastern day; only visible in parent mode', async () => {
  const p = await h.parentLogin();
  const a = (await addChild(p, { username: 'child_aaa' })).body.profile;
  const b = (await addChild(p, { username: 'child_bbb' })).body.profile;
  // no profile active → heartbeat refused
  assert.equal((await api().post('/api/v1/profiles/activity').set(p.auth).send({ seconds: 60 })).status, 403);
  const sw = await api().post(`/api/v1/profiles/${a.id}/switch`).set(p.auth).send({ pin: '1234' });
  const kid = bearer(sw.body.accessToken);
  assert.equal((await api().post('/api/v1/profiles/activity').set(kid).send({ seconds: 60 })).status, 200);
  assert.equal((await api().post('/api/v1/profiles/activity').set(kid).send({ seconds: 90 })).status, 200);
  assert.equal((await api().post('/api/v1/profiles/activity').set(kid).send({ seconds: 99999 })).status, 400);   // capped per call
  assert.equal((await api().post('/api/v1/profiles/activity').set(kid).send({ seconds: 0 })).status, 400);
  // a child cannot read the report
  assert.equal((await api().get('/api/v1/parent/report').set(kid)).body.error.code, 'PARENT_MODE_REQUIRED');
  const back = await api().post('/api/v1/profiles/parent-mode').set(kid).send({ pin: '1234' });
  const rep = await api().get('/api/v1/parent/report').set(bearer(back.body.accessToken));
  assert.equal(rep.status, 200);
  const ra = rep.body.children.find((c) => c.profileId === a.id); const rb = rep.body.children.find((c) => c.profileId === b.id);
  assert.equal(ra.todaySeconds, 150); assert.equal(ra.totals.activeSeconds, 150); assert.equal(ra.byDay.length, 1);
  assert.equal(rb.todaySeconds, 0);
  const one = await api().get('/api/v1/parent/report').set(bearer(back.body.accessToken)).query({ profileId: b.id, days: 3 });
  assert.equal(one.body.children.length, 1);
  // another parent's child is not found
  const other = await h.parentLogin('other@example.org');
  assert.equal((await api().get('/api/v1/parent/report').set(other.auth).query({ profileId: a.id })).status, 404);
  // deleting the child removes their activity rows
  await api().delete(`/api/v1/profiles/${a.id}`).set(bearer(back.body.accessToken)).send({ pin: '1234', confirm: true });
  assert.equal((await h.query('SELECT COUNT(*) n FROM profile_daily_activity'))[0].n, 0);
});
