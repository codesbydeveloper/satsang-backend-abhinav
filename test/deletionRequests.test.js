const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { api, bearer } = h;

beforeEach(h.resetDb);
after(() => h.pool.end());

const URL = '/api/v1/admin/deletion-requests';

async function setup() {
  const b = await h.adminLogin(await h.makeAdmin('boss@example.org'));
  const adult = await h.adultLogin('ravi@example.org', 'ravi_k');
  const parent = await h.parentLogin('parent@example.org');
  for (const username of ['kid_one', 'kid_two']) {
    const c = await api().post('/api/v1/profiles').set(parent.auth).send({ pin: '1234', username, avatarId: 2, dob: h.dobYearsAgo(8), parentalConsent: true });
    assert.equal(c.status, 201, JSON.stringify(c.body));
  }
  const fromAdult = (await api().post('/api/v1/public/delete-account').send({ email: 'ravi@example.org', password: 'Secret123', confirm: true })).body;
  const fromWeb = (await api().post('/api/v1/public/delete-account').send({ email: 'parent@example.org', password: 'Secret123', confirm: true })).body;
  return { b, adult, parent, fromAdult, fromWeb };
}

test('list: pending tab with counts, search, source filter; Full Admin only', async () => {
  const { b, fromAdult, fromWeb } = await setup();
  const l = await api().get(URL).set(bearer(b.token));
  assert.equal(l.status, 200);
  assert.deepEqual(l.body.counts, { pending: 2, completed: 0, rejected: 0, all: 2 });
  assert.equal(l.body.total, 2);
  assert.deepEqual(l.body.rows.map((r) => r.id).sort(), [fromAdult.requestId, fromWeb.requestId].sort());
  const adultRow = l.body.rows.find((r) => r.id === fromAdult.requestId);
  assert.equal(adultRow.username, 'ravi_k');
  assert.equal(adultRow.email, 'ravi@example.org');
  assert.equal(adultRow.accountType, 'adult');
  assert.equal(adultRow.source, 'web');
  assert.equal(adultRow.emailVerified, true);
  assert.equal(adultRow.childProfiles, 0);
  const parentRow = l.body.rows.find((r) => r.id === fromWeb.requestId);
  assert.equal(parentRow.username, null);           // parents have no profile of their own
  assert.equal(parentRow.childProfiles, 2);
  assert.equal(parentRow.source, 'web');

  assert.equal((await api().get(URL).set(bearer(b.token)).query({ q: 'kid_two' })).body.rows[0].id, fromWeb.requestId);   // child username finds the parent
  assert.equal((await api().get(URL).set(bearer(b.token)).query({ q: 'ravi' })).body.total, 1);
  const app = await api().get(URL).set(bearer(b.token)).query({ source: 'app' });
  assert.deepEqual(app.body.counts, { pending: 0, completed: 0, rejected: 0, all: 0 }, 'in-app deletions never wait for approval');
  assert.equal((await api().get(URL).set(bearer(b.token)).query({ status: 'bogus' })).status, 400);

  const ed = await h.adminLogin(await h.makeAdmin('editor@example.org', 'content_editor'));
  assert.equal((await api().get(URL).set(bearer(ed.token))).status, 403);
  assert.equal((await api().get(URL)).status, 401);
});

test('view: request, account and profiles without DOBs; audited', async () => {
  const { b, fromWeb } = await setup();
  const v = await api().get(`${URL}/${fromWeb.requestId}`).set(bearer(b.token));
  assert.equal(v.status, 200);
  assert.equal(v.body.account.email, 'parent@example.org');
  assert.deepEqual(v.body.profiles.map((p) => p.username), ['kid_one', 'kid_two']);
  assert.ok(!JSON.stringify(v.body).match(/dob|password|pin_hash/i));
  assert.equal((await api().get(`${URL}/999999`).set(bearer(b.token))).status, 404);
  assert.equal((await h.query("SELECT COUNT(*) n FROM audit_log WHERE action = 'deletion_request.viewed'"))[0].n, 1);
});

test('approve deletes the account and child profiles, keeps no email, and cannot be repeated', async () => {
  const { b, parent, fromWeb } = await setup();
  const url = `${URL}/${fromWeb.requestId}/approve`;
  assert.equal((await api().post(url).set(bearer(b.token)).send({})).status, 400);   // confirm required
  const r = await api().post(url).set(bearer(b.token)).send({ confirm: true, note: 'Checked' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { id: fromWeb.requestId, status: 'completed', accountId: parent.account.id, profilesDeleted: 2 });
  assert.equal((await h.query('SELECT COUNT(*) n FROM accounts WHERE id = ?', [parent.account.id]))[0].n, 0);
  assert.equal((await api().get('/api/v1/me').set(parent.auth)).status, 401);
  assert.equal((await api().post(url).set(bearer(b.token)).send({ confirm: true })).body.error.code, 'DELETION_REQUEST_DECIDED');

  const done = await api().get(URL).set(bearer(b.token)).query({ status: 'completed' });
  assert.equal(done.body.rows.length, 1);
  assert.equal(done.body.rows[0].email, null);
  assert.equal(done.body.rows[0].childProfiles, 2);
  assert.equal(done.body.rows[0].decidedBy.name, 'boss');
  assert.equal(done.body.counts.pending, 1);
  const v = await api().get(`${URL}/${fromWeb.requestId}`).set(bearer(b.token));
  assert.equal(v.body.account, null);
  assert.deepEqual(v.body.profiles, []);

  const log = (await h.query("SELECT details FROM audit_log WHERE action = 'deletion_request.approved'"))[0];
  assert.equal(log.details.profilesDeleted, 2);
  assert.ok(!JSON.stringify(log.details).includes('parent@example.org'));
});

test('reject keeps the account, needs a reason, and the owner can ask again', async () => {
  const { b, adult, fromAdult } = await setup();
  const url = `${URL}/${fromAdult.requestId}/reject`;
  assert.equal((await api().post(url).set(bearer(b.token)).send({})).status, 400);
  const r = await api().post(url).set(bearer(b.token)).send({ reason: 'Could not confirm ownership' });
  assert.deepEqual(r.body, { id: fromAdult.requestId, status: 'rejected', accountId: adult.account.id });
  assert.equal((await api().get('/api/v1/me').set(bearer(adult.accessToken))).status, 200);
  assert.equal((await api().post(`${URL}/${fromAdult.requestId}/approve`).set(bearer(b.token)).send({ confirm: true })).status, 409);

  const rejected = await api().get(URL).set(bearer(b.token)).query({ status: 'rejected' });
  assert.equal(rejected.body.rows[0].decisionNote, 'Could not confirm ownership');
  assert.equal(rejected.body.rows[0].email, 'ravi@example.org');   // account still exists

  const again = await api().post('/api/v1/public/delete-account').send({ email: 'ravi@example.org', password: 'Secret123', confirm: true });
  assert.equal(again.status, 202);
  assert.notEqual(again.body.requestId, fromAdult.requestId);
  assert.equal((await h.query("SELECT details FROM audit_log WHERE action = 'deletion_request.rejected'"))[0].details.reason, 'Could not confirm ownership');
});

test('deleting a user from the Users page closes their pending request', async () => {
  const { b, adult, fromAdult } = await setup();
  await api().delete(`/api/v1/admin/users/${adult.account.id}`).set(bearer(b.token)).send({ confirm: true, reason: 'Duplicate account' });
  const row = (await h.query('SELECT status FROM account_deletion_requests WHERE id = ?', [fromAdult.requestId]))[0];
  assert.equal(row.status, 'completed');
});

test('deleting in the app: completed at once, listed as source app with no admin; closes a pending web request', async () => {
  const { b, adult, parent, fromWeb } = await setup();
  // the parent asked on the web page, then deletes in the app: the same request is completed, no second row
  const del = await api().delete('/api/v1/me').set(parent.auth).send({ password: 'Secret123', confirm: true });
  assert.deepEqual(del.body, { deleted: true, profilesDeleted: 2 });
  const closed = (await h.query('SELECT * FROM account_deletion_requests WHERE account_id = ?', [parent.account.id]));
  assert.equal(closed.length, 1);
  assert.equal(closed[0].id, fromWeb.requestId);
  assert.equal(closed[0].status, 'completed');
  assert.equal(closed[0].profiles_deleted, 2);

  // a fresh adult with no request deletes in the app: a completed "app" row appears in the history
  const solo = await h.adultLogin('solo@example.org', 'solo_one');
  await api().delete('/api/v1/me').set(bearer(solo.accessToken)).send({ password: 'Secret123', confirm: true });
  const done = await api().get(URL).set(bearer(b.token)).query({ status: 'completed', source: 'app' });
  assert.equal(done.body.rows.length, 1);
  const row = done.body.rows[0];
  assert.equal(row.accountId, solo.account.id);
  assert.equal(row.deletedByOwner, true);
  assert.equal(row.decidedBy, null);
  assert.equal(row.email, null);
  assert.equal(row.username, null);
  assert.equal(row.profilesDeleted, 1);
  assert.equal(done.body.counts.pending, 0, 'in-app deletions never wait in the queue');
  // the adult's pending web request is untouched
  assert.equal((await h.query('SELECT status FROM account_deletion_requests WHERE account_id = ?', [adult.account.id]))[0].status, 'pending');
});
