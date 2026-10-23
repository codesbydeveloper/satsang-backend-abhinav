const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { api, bearer } = h;

beforeEach(h.resetDb);
after(() => h.pool.end());

test('dashboard returns live counts, chart, recent sign-ups and admin activity', async () => {
  const boss = await h.makeAdmin('boss@example.org');
  const { token } = await h.adminLogin(boss);
  await h.adultLogin('ravi@example.org', 'ravi_k');
  const parent = await h.parentLogin('parent@example.org');
  const child = await api().post('/api/v1/profiles').set(parent.auth)
    .send({ pin: '1234', username: 'little_one', avatarId: 2, dob: h.dobYearsAgo(8), mode: 'sanatan', language: 'gu', parentalConsent: true });
  assert.equal(child.status, 201, JSON.stringify(child.body));

  const r = await api().get('/api/v1/admin/dashboard').set(bearer(token));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const b = r.body;
  assert.deepEqual(b.totals, { accounts: 2, adultAccounts: 1, parentAccounts: 1, profiles: 2, childProfiles: 1, newRegistrationsToday: 2 });
  assert.equal(b.ageGroups.length, 9);
  assert.equal(b.ageGroups.find((g) => g.ageGroup === 'Yuvak/Yuvatis A').count, 1);
  assert.equal(b.ageGroups.find((g) => g.ageGroup === 'Bals/Balikas B').count, 1);
  assert.equal(b.registrations.series.length, 7);
  assert.equal(b.registrations.total, 2);
  assert.deepEqual(b.modes, [{ key: 'sanatan', count: 1 }, { key: 'satsang', count: 1 }]);
  assert.deepEqual(b.languages, [{ key: 'en', count: 1 }, { key: 'gu', count: 1 }]);
  assert.deepEqual(b.recentRegistrations.map((x) => x.type).sort(), ['adult', 'child', 'parent']);
  assert.equal(b.recentRegistrations.find((x) => x.type === 'parent').username, null);
  assert.ok(!JSON.stringify(b.recentRegistrations).includes('@'), 'no emails in recent registrations');
  assert.ok(!JSON.stringify(b).includes('"dob"'), 'no DOBs');
  assert.ok(b.recentAdminActivity.some((x) => x.action === 'admin.login' && x.adminName === 'boss'));

  const month = await api().get('/api/v1/admin/dashboard?days=30').set(bearer(token));
  assert.equal(month.body.registrations.series.length, 30);
  assert.equal((await api().get('/api/v1/admin/dashboard?days=12').set(bearer(token))).status, 400);
});

test('dashboard is Full Admin only', async () => {
  const ed = await h.makeAdmin('editor@example.org', 'content_editor');
  const e = await h.adminLogin(ed);
  assert.equal((await api().get('/api/v1/admin/dashboard').set(bearer(e.token))).status, 403);
  assert.equal((await api().get('/api/v1/admin/dashboard')).status, 401);
});
