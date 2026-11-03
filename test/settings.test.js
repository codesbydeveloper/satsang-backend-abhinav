// Part 8: settings (language / path), change password and account deletion rules for parent accounts.
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { api, bearer } = h;

beforeEach(h.resetDb);
after(() => h.pool.end());

const addChild = (p, username) => api().post('/api/v1/profiles').set(p.auth)
  .send({ username, avatarId: 2, dob: h.dobYearsAgo(8, 30), parentalConsent: true, mode: 'satsang' });
const asChild = async (p, id) => bearer((await api().post('/api/v1/me/active-profile').set(p.auth).send({ profileId: id })).body.accessToken);

test('settings: an independent account changes language and path any time', async () => {
  const a = await h.adultLogin();
  const auth = bearer(a.accessToken);
  const r = await api().patch('/api/v1/me/settings').set(auth).send({ language: 'gu', mode: 'sanatan' });
  assert.equal(r.status, 200);
  assert.equal(r.body.account.language, 'gu');
  assert.equal(r.body.profile.language, 'gu');
  assert.equal(r.body.profile.mode, 'sanatan');
  assert.equal((await api().patch('/api/v1/me/settings').set(auth).send({ mode: 'satsang' })).body.profile.mode, 'satsang');
  assert.equal((await api().patch('/api/v1/me/settings').set(auth).send({})).body.error.code, 'VALIDATION_ERROR');
  assert.equal((await api().patch('/api/v1/me/settings').set(auth).send({ language: 'fr' })).status, 400);
});

test('settings: parent area sets its language (no path); a child cannot change settings', async () => {
  const p = await h.parentLogin();
  const kid = (await addChild(p, 'kid_aaa')).body.profile;
  const area = await api().patch('/api/v1/me/settings').set(p.auth).send({ language: 'gu' });
  assert.equal(area.status, 200);
  assert.equal(area.body.account.language, 'gu');
  assert.equal(area.body.profile, null);
  assert.equal((await api().patch('/api/v1/me/settings').set(p.auth).send({ mode: 'sanatan' })).body.error.code, 'NO_ACTIVE_PROFILE');

  const child = await asChild(p, kid.id);
  for (const body of [{ language: 'en' }, { mode: 'sanatan' }]) {
    const refused = await api().patch('/api/v1/me/settings').set(child).send(body);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, 'PARENT_MODE_REQUIRED');
  }
  const row = (await h.query('SELECT language, mode FROM profiles WHERE id = ?', [kid.id]))[0];
  assert.equal(row.mode, 'satsang', 'unchanged');
});

test('a parent account changes its password or deletes itself only from the parent area', async () => {
  const p = await h.parentLogin();
  const kid = (await addChild(p, 'kid_aaa')).body.profile;
  const child = await asChild(p, kid.id);
  assert.equal((await api().post('/api/v1/me/password').set(child).send({ currentPassword: 'Secret123', newPassword: 'Changed4567' })).body.error.code, 'PARENT_MODE_REQUIRED');
  assert.equal((await api().delete('/api/v1/me').set(child).send({ password: 'Secret123', confirm: true })).body.error.code, 'PARENT_MODE_REQUIRED');
  assert.equal((await h.query('SELECT COUNT(*) n FROM profiles'))[0].n, 1, 'nothing deleted');

  const area = bearer((await api().post('/api/v1/me/active-profile').set(child).send({ profileId: null, pin: '1234' })).body.accessToken);
  const changed = await api().post('/api/v1/me/password').set(area).send({ currentPassword: 'Secret123', newPassword: 'Changed4567' });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.activeProfileId, null);
  const del = await api().delete('/api/v1/me').set(bearer(changed.body.accessToken)).send({ password: 'Changed4567', confirm: true });
  assert.deepEqual(del.body, { deleted: true, profilesDeleted: 1 });
  assert.equal((await h.query('SELECT COUNT(*) n FROM profile_daily_activity'))[0].n, 0);
});

test('deleting a child: parent accounts only, child profiles only, other children and their data untouched', async () => {
  const p = await h.parentLogin();
  const a = (await addChild(p, 'kid_aaa')).body.profile;
  const b = (await addChild(p, 'kid_bbb')).body.profile;
  // some daily time for both
  for (const id of [a.id, b.id]) {
    const auth = await asChild(p, id);
    await api().post('/api/v1/me/activity/heartbeat').set(auth).send({ beats: [{ at: new Date().toISOString(), seconds: 60 }] });
    await api().post('/api/v1/me/active-profile').set(auth).send({ profileId: null, pin: '1234' });
  }
  const del = await api().delete(`/api/v1/profiles/${a.id}`).set(p.auth).send({ pin: '1234', confirm: true });
  assert.equal(del.status, 200);
  assert.deepEqual((await h.query('SELECT profile_id FROM profile_daily_activity')).map((r) => r.profile_id), [b.id]);
  assert.equal((await api().get('/api/v1/me').set(p.auth)).status, 200, 'the parent stays logged in');

  const adult = await h.adultLogin();
  assert.equal((await api().delete(`/api/v1/profiles/${adult.activeProfileId}`).set(bearer(adult.accessToken)).send({ pin: '1234', confirm: true })).body.error.code, 'PARENT_ONLY');
  const other = await h.parentLogin('other@example.org');
  assert.equal((await api().delete(`/api/v1/profiles/${b.id}`).set(other.auth).send({ pin: '1234', confirm: true })).status, 404, "another parent's child");
});

test('/api-docs.json documents the Part 8 endpoints', async () => {
  const doc = (await api().get('/api-docs.json')).body;
  assert.ok(doc.paths['/me/password'].post);
  assert.ok(doc.paths['/me/settings'].patch);
  assert.ok(doc.paths['/me'].delete.responses['200']);
  assert.ok(!doc.paths['/me'].delete.responses['202'], 'no longer a request');
  assert.ok(doc.paths['/profiles/{id}'].delete);
  assert.ok(!doc.paths['/me/change-password'], 'replaced by /me/password');
});
