// All timestamps are stored in UTC and leave the API as ISO 8601 strings ending in "Z" (19 Nov 2026).
// Regression: DEFAULT CURRENT_TIMESTAMP columns used the MySQL server's local zone (IST), so an in-app deletion showed
// REQUESTED 23:02:37 but HANDLED 17:32:37 for the same moment.
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { api, bearer } = h;
const { jsonTimestamps, toIso } = require('../src/utils/time');

beforeEach(h.resetDb);
after(() => h.pool.end());

const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** An API timestamp: ISO UTC and within a minute of now (a 5h30 shift fails this). */
const isNow = (s, what) => {
  assert.match(s, ISO_Z, `${what} is ISO UTC: ${s}`);
  assert.ok(Math.abs(Date.parse(s) - Date.now()) < 60000, `${what} is now, got ${s}`);
};

test('jsonTimestamps: DATETIME strings in *At / *_at / *Until fields become ISO UTC; everything else is unchanged', () => {
  assert.equal(toIso('2026-11-19 12:02:37'), '2026-11-19T12:02:37.000Z');
  const out = JSON.parse(JSON.stringify({
    requestedAt: '2026-11-19 12:02:37', created_at: '2026-11-19 00:00:00', emailRetainedUntil: '2026-12-19 12:02:37',
    decidedAt: null, generatedAt: '2026-11-19T12:02:37.000Z', dob: '2000-01-31', gameDay: '2026-11-19',
    decisionNote: '2026-11-19 12:02:37', nested: [{ lastLoginAt: '2026-11-19 05:30:00' }],
  }, jsonTimestamps));
  assert.deepEqual(out, {
    requestedAt: '2026-11-19T12:02:37.000Z', created_at: '2026-11-19T00:00:00.000Z', emailRetainedUntil: '2026-12-19T12:02:37.000Z',
    decidedAt: null, generatedAt: '2026-11-19T12:02:37.000Z', dob: '2000-01-31', gameDay: '2026-11-19',
    decisionNote: '2026-11-19 12:02:37', nested: [{ lastLoginAt: '2026-11-19T05:30:00.000Z' }],
  });
});

test('every pooled connection runs in UTC, whatever the MySQL server zone is', async () => {
  for (let i = 0; i < 3; i++) {
    const [r] = await h.query('SELECT @@session.time_zone AS tz, TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), NOW()) AS diff');
    assert.equal(r.tz, '+00:00');
    assert.equal(Number(r.diff), 0);
  }
});

test('in-app deletion: requested and handled are the same UTC moment, returned as ISO "Z" strings', async () => {
  const b = await h.adminLogin(await h.makeAdmin('boss@example.org'));
  const adult = await h.adultLogin('ravi@example.org', 'ravi_k');
  await api().delete('/api/v1/me').set(bearer(adult.accessToken)).send({ password: 'Secret123', confirm: true });

  const [db] = await h.query('SELECT id, TIMESTAMPDIFF(SECOND, requested_at, decided_at) AS gap, TIMESTAMPDIFF(SECOND, requested_at, UTC_TIMESTAMP()) AS age FROM account_deletion_requests');
  assert.ok(Math.abs(Number(db.gap)) <= 2, `requested_at and decided_at are stored in the same zone, gap ${db.gap}s`);
  assert.ok(Math.abs(Number(db.age)) <= 60, `requested_at is UTC, ${db.age}s from UTC now`);

  const r = (await api().get(`/api/v1/admin/deletion-requests/${db.id}`).set(bearer(b.token))).body.request;
  isNow(r.requestedAt, 'requestedAt'); isNow(r.decidedAt, 'decidedAt');
  assert.ok(Math.abs(Date.parse(r.decidedAt) - Date.parse(r.requestedAt)) <= 2000);
  assert.match(r.emailRetainedUntil, ISO_Z);
  const row = (await api().get('/api/v1/admin/deletion-requests').set(bearer(b.token)).query({ status: 'completed' })).body.rows[0];
  assert.equal(row.requestedAt, r.requestedAt);
});

test('web deletion request: requestedAt from the public endpoint and the admin list is ISO UTC', async () => {
  const b = await h.adminLogin(await h.makeAdmin('boss@example.org'));
  await h.adultLogin('ravi@example.org', 'ravi_k');
  const p = await api().post('/api/v1/public/delete-account').send({ email: 'ravi@example.org', password: 'Secret123', confirm: true });
  isNow(p.body.requestedAt, 'public requestedAt');
  const row = (await api().get('/api/v1/admin/deletion-requests').set(bearer(b.token))).body.rows[0];
  assert.equal(row.requestedAt, p.body.requestedAt);
  assert.equal(row.decidedAt, null);
});

test('users, user detail, audit log, admins and referrals: timestamps are ISO UTC and now; dob stays a plain date', async () => {
  const b = await h.adminLogin(await h.makeAdmin('boss@example.org'));
  const friend = await h.adultLogin('friend@example.org', 'friend_1');
  const code = (await api().get('/api/v1/me/referral').set(bearer(friend.accessToken))).body.code;
  const newbie = await h.adultLogin('new@example.org', 'new_one');
  assert.equal((await api().post('/api/v1/me/referral/apply').set(bearer(newbie.accessToken)).send({ code })).status, 200);
  const auth = bearer(b.token);

  const users = (await api().get('/api/v1/admin/users').set(auth)).body.rows;
  assert.equal(users.length, 2);
  for (const u of users) isNow(u.createdAt, 'user createdAt');
  const detail = (await api().get(`/api/v1/admin/users/${newbie.account.id}`).set(auth)).body;
  isNow(detail.account.createdAt, 'account createdAt'); isNow(detail.account.consentAcceptedAt, 'consentAcceptedAt');
  for (const p of detail.profiles) isNow(p.createdAt, 'profile createdAt');

  const audit = (await api().get('/api/v1/admin/audit-log').set(auth)).body.entries;
  assert.ok(audit.length > 0);
  for (const e of audit) isNow(e.createdAt, 'audit createdAt');

  const admins = (await api().get('/api/v1/admin/admins').set(auth)).body;
  const me = (admins.admins || admins).find((a) => a.email === 'boss@example.org');
  isNow(me.createdAt, 'admin createdAt'); isNow(me.lastLoginAt, 'admin lastLoginAt');

  const refs = (await api().get('/api/v1/admin/referrals').set(auth)).body.rows;
  assert.equal(refs.length, 1);
  isNow(refs[0].createdAt, 'referral createdAt');

  const own = (await api().get('/api/v1/me').set(bearer(newbie.accessToken))).body;
  const dob = JSON.stringify(own).match(/"dob":"([^"]+)"/)[1];
  assert.match(dob, /^\d{4}-\d{2}-\d{2}$/, 'dob is not turned into a timestamp');
});
