// Dashboard cards (client 23 Nov 2026): every total equals the Users table count (totalRows) for the filter its card
// opens, so the numbers always agree.
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { api, bearer } = h;
const { startOfDayIn } = require('../src/utils/time');

beforeEach(h.resetDb);
after(() => h.pool.end());

const addChild = async (p, username) => {
  const r = await api().post('/api/v1/profiles').set(p.auth).send({ username, avatarId: 2, dob: h.dobYearsAgo(9, 30), parentalConsent: true });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body.profile;
};
const setStatus = (auth, id, body) => api().put(`/api/v1/profiles/${id}/student-status`).set(auth).send(body);

test('startOfDayIn: midnight in the zone as a UTC instant, DST-aware', () => {
  assert.equal(startOfDayIn('Asia/Kolkata', '2026-11-23').toISOString(), '2026-11-22T18:30:00.000Z');
  assert.equal(startOfDayIn('UTC', '2026-11-23').toISOString(), '2026-11-23T00:00:00.000Z');
  assert.equal(startOfDayIn('America/New_York', '2026-07-01').toISOString(), '2026-07-01T04:00:00.000Z');
  assert.equal(startOfDayIn('America/New_York', '2026-12-01').toISOString(), '2026-12-01T05:00:00.000Z');
  assert.equal(startOfDayIn('America/New_York', '2026-03-08').toISOString(), '2026-03-08T05:00:00.000Z', 'DST starts later that day');
});

test('dashboard totals = Users table totalRows for each card filter', async () => {
  const a = await h.adultLogin('anil@example.org', 'anil_a');
  await h.adultLogin('zara@example.org', 'zara_z');
  const p1 = await h.parentLogin('p1@example.org');
  const p2 = await h.parentLogin('p2@example.org');
  const k1 = await addChild(p1, 'kid_one'); await addChild(p1, 'kid_two'); const k3 = await addChild(p2, 'kid_three');
  await setStatus(p1.auth, k1.id, { enrolled: true });
  await setStatus(p2.auth, k3.id, { enrolled: false, interested: true });
  await setStatus(bearer(a.accessToken), a.profiles[0].id, { enrolled: true });
  // an older account: not "today"
  await h.query("UPDATE accounts SET created_at = UTC_TIMESTAMP() - INTERVAL 3 DAY WHERE email = 'zara@example.org'");

  const token = (await h.adminLogin(await h.makeAdmin('boss@example.org'))).token;
  const t = (await api().get('/api/v1/admin/dashboard').set(bearer(token))).body.totals;
  assert.deepEqual([t.adultAccounts, t.parentAccounts, t.childProfiles, t.studentsToVerify], [2, 2, 3, 3]);
  assert.match(t.todayStartsAt, /Z$/);

  const rowsFor = async (query) => {
    const r = await api().get('/api/v1/admin/users').set(bearer(token)).query(query);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.totalRows;
  };
  assert.equal(await rowsFor({ accountType: 'adult' }), t.adultAccounts);
  assert.equal(await rowsFor({ accountType: 'parent' }), t.parentAccounts);
  assert.equal(await rowsFor({ accountType: 'child' }), t.childProfiles);
  assert.equal(await rowsFor({ studentStatus: 'pending_verification,interested' }), t.studentsToVerify);
  assert.equal(await rowsFor({ joinedSince: t.todayStartsAt }), t.newRegistrationsToday);
  assert.equal(t.newRegistrationsToday, 3, 'zara joined 3 days ago');
  // joinedSince counts accounts, not the children added today
  const today = await api().get('/api/v1/admin/users').set(bearer(token)).query({ joinedSince: t.todayStartsAt, sort: 'email' });
  assert.deepEqual(today.body.rows.filter((r) => r.matched).map((r) => r.email), ['anil@example.org', 'p1@example.org', 'p2@example.org']);
  assert.equal((await api().get('/api/v1/admin/users').set(bearer(token)).query({ joinedSince: 'yesterday' })).status, 400);
});
