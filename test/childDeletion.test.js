// Parts D + E (23 Nov 2026): deleting ONE child vs the parent account with all children; completed deletion entries
// keep the username and email for RETAINED_EMAIL_DAYS (Full Admins only), then show only the request id.
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { api, bearer, outbox } = h;
const { purgeRetainedEmails } = require('../src/utils/retainedEmails');

beforeEach(h.resetDb);
after(() => h.pool.end());

const URL = '/api/v1/admin/deletion-requests';
const SUBJECT = '🙏 Satsang Spark – Account Deletion Confirmation';
const addChild = (p, username, years = 8) => api().post('/api/v1/profiles').set(p.auth)
  .send({ username, avatarId: 2, dob: h.dobYearsAgo(years, 30), parentalConsent: true });

/** A parent with two children, each with progress and reserved Sparks; returns ids and the admin. */
async function family() {
  const b = await h.adminLogin(await h.makeAdmin('boss@example.org'));
  const parent = await h.parentLogin('parent@example.org');
  const kidA = (await addChild(parent, 'kid_alpha')).body.profile;
  const kidB = (await addChild(parent, 'kid_beta')).body.profile;
  for (const [id, sparks] of [[kidA.id, 30], [kidB.id, 70]]) {
    await h.query('INSERT INTO profile_daily_activity (profile_id, game_day, active_seconds, quizzes_completed, sparks_earned) VALUES (?, CURDATE(), 600, 2, ?)', [id, sparks]);
    await h.query("INSERT INTO profile_sparks_rewards (profile_id, reward, sparks, tx_id) VALUES (?, 'student_verified', 10, ?)", [id, `student_verified-${id}`]);
    await h.query("UPDATE profiles SET student_status = 'verified', student_sparks_awarded = 10 WHERE id = ?", [id]);
  }
  return { b, parent, kidA, kidB };
}
const snapshot = async (accountId, profileId) => ({
  account: (await h.query('SELECT id, email, password_hash, parent_pin_hash FROM accounts WHERE id = ?', [accountId]))[0],
  bonus: (await h.query('SELECT sparks, status FROM signup_bonuses WHERE account_id = ?', [accountId]))[0] || null,
  profile: (await h.query('SELECT id, username, student_status, student_sparks_awarded FROM profiles WHERE id = ?', [profileId]))[0],
  activity: await h.query('SELECT game_day, active_seconds, quizzes_completed, sparks_earned FROM profile_daily_activity WHERE profile_id = ?', [profileId]),
  rewards: await h.query('SELECT reward, sparks, status FROM profile_sparks_rewards WHERE profile_id = ?', [profileId]),
});
const delChild = (b, id, body = { confirm: true, reason: 'Parent asked by phone' }) =>
  api().delete(`/api/v1/admin/users/profiles/${id}`).set(bearer(b.token)).send(body);

test('deleting ONE child removes only that child; the parent and the sibling keep account, progress and Sparks', async () => {
  const { b, parent, kidA, kidB } = await family();
  const before = await snapshot(parent.account.id, kidB.id);
  const r = await delChild(b, kidA.id);
  assert.equal(r.status, 200);
  assert.deepEqual({ ...r.body, sessionsEnded: undefined }, { deleted: true, profileId: kidA.id, parentAccountId: parent.account.id, sessionsEnded: undefined });

  // the child and everything it owned are gone
  assert.equal((await h.query('SELECT COUNT(*) n FROM profiles WHERE id = ?', [kidA.id]))[0].n, 0);
  assert.equal((await h.query('SELECT COUNT(*) n FROM profile_daily_activity WHERE profile_id = ?', [kidA.id]))[0].n, 0);
  assert.equal((await h.query('SELECT COUNT(*) n FROM profile_sparks_rewards WHERE profile_id = ?', [kidA.id]))[0].n, 0);
  // the parent account and the sibling are exactly as before
  assert.deepEqual(await snapshot(parent.account.id, kidB.id), before);
  assert.equal((await api().get('/api/v1/me').set(parent.auth)).status, 200, 'the parent is still logged in');
  assert.equal(outbox.filter((m) => m.subject === SUBJECT).length, 0, 'no account-deleted email for one child');

  const a = (await h.query("SELECT entity_type, entity_id, details FROM audit_log WHERE action = 'child.deleted'"))[0];
  assert.equal(a.entity_type, 'profile');
  assert.equal(Number(a.entity_id), kidA.id);
  assert.equal(a.details.profileId, kidA.id);
  assert.equal(a.details.parentAccountId, parent.account.id);
  assert.ok(!JSON.stringify(a.details).includes('kid_alpha') && !JSON.stringify(a.details).includes('parent@'), 'ids only in the audit log');
});

test('child delete: adult profiles are refused, unknown ids 404, confirm + reason required, Content Editors 403', async () => {
  const { b, kidA } = await family();
  const adult = await h.adultLogin('ravi@example.org', 'ravi_k');
  const own = adult.profiles ? adult.profiles[0].id : (await h.query('SELECT id FROM profiles WHERE account_id = ?', [adult.account.id]))[0].id;
  assert.equal((await delChild(b, own)).body.error.code, 'NOT_A_CHILD_PROFILE');
  assert.equal((await h.query('SELECT COUNT(*) n FROM profiles WHERE id = ?', [own]))[0].n, 1);
  assert.equal((await delChild(b, 999999)).status, 404);
  assert.equal((await delChild(b, kidA.id, { reason: 'no confirm' })).status, 400);
  assert.equal((await delChild(b, kidA.id, { confirm: true })).status, 400, 'reason required');
  const ed = await h.adminLogin(await h.makeAdmin('editor@example.org', 'content_editor'));
  assert.equal((await delChild(ed, kidA.id)).status, 403);
  assert.equal((await h.query('SELECT COUNT(*) n FROM profiles WHERE id = ?', [kidA.id]))[0].n, 1, 'nothing deleted by refused calls');
});

test('deleting the PARENT account removes every child; the parent is emailed; a completed admin entry is listed', async () => {
  const { b, parent, kidA, kidB } = await family();
  const r = await api().delete(`/api/v1/admin/users/${parent.account.id}`).set(bearer(b.token)).send({ confirm: true, reason: 'Family asked' });
  assert.equal(r.status, 200);
  assert.equal(r.body.profilesDeleted, 2);
  assert.equal((await h.query('SELECT COUNT(*) n FROM profiles WHERE id IN (?)', [[kidA.id, kidB.id]]))[0].n, 0);
  assert.equal((await h.query('SELECT COUNT(*) n FROM profile_sparks_rewards'))[0].n, 0);
  assert.equal((await h.query('SELECT COUNT(*) n FROM accounts WHERE id = ?', [parent.account.id]))[0].n, 0);
  assert.equal(outbox.filter((m) => m.to === 'parent@example.org' && m.subject === SUBJECT).length, 1);

  const l = await api().get(URL).set(bearer(b.token)).query({ status: 'completed' });
  assert.equal(l.body.rows.length, 1);
  const row = l.body.rows[0];
  assert.deepEqual({ source: row.source, target: row.target, type: row.accountType, email: row.email, username: row.username, kids: row.childProfiles, parentEmail: row.isParentEmail },
    { source: 'admin', target: 'account', type: 'parent', email: 'parent@example.org', username: null, kids: 2, parentEmail: true });
  assert.equal(row.decidedBy.id, b.admin.id);
});

test('a deleted child is a completed entry: child username + parent email, searchable, then "details removed"', async () => {
  const { b, parent, kidA } = await family();
  await delChild(b, kidA.id);
  const find = (q) => api().get(URL).set(bearer(b.token)).query({ status: 'completed', ...(q ? { q } : {}) });
  let l = await find();
  assert.equal(l.body.rows.length, 1);
  const row = l.body.rows[0];
  assert.deepEqual({ target: row.target, profileId: row.profileId, accountId: row.accountId, source: row.source, username: row.username, email: row.email, parentEmail: row.isParentEmail, kids: row.childProfiles, deleted: row.profilesDeleted },
    { target: 'child_profile', profileId: kidA.id, accountId: parent.account.id, source: 'admin', username: 'kid_alpha', email: 'parent@example.org', parentEmail: true, kids: 0, deleted: 1 });
  assert.ok(new Date(row.emailRetainedUntil) - Date.now() > 29 * 86400000);

  assert.deepEqual((await find('kid_al')).body.rows.map((r) => r.id), [row.id], 'retained username matches');
  assert.deepEqual((await find('parent@')).body.rows.map((r) => r.id), [row.id], 'retained (parent) email matches');
  assert.deepEqual((await find(`#${row.id}`)).body.rows.map((r) => r.id), [row.id], 'request id matches');

  // the period is over: nothing personal is shown or searchable, even before the purge runs
  await h.query('UPDATE account_deletion_requests SET email_retained_until = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE) WHERE id = ?', [row.id]);
  l = await find();
  assert.equal(l.body.rows[0].username, null);
  assert.equal(l.body.rows[0].email, null);
  assert.ok(new Date(l.body.rows[0].emailRetainedUntil) < Date.now());
  assert.equal((await find('kid_al')).body.rows.length, 0);
  assert.equal((await find('parent@')).body.rows.length, 0);
  assert.deepEqual((await find(String(row.id))).body.rows.map((r) => r.id), [row.id], 'still found by its id');
});

test('the purge erases the retained username as well as the email', async () => {
  const { b, kidA } = await family();
  await delChild(b, kidA.id);
  const adult = await h.adultLogin('ravi@example.org', 'ravi_k');
  await api().delete('/api/v1/me').set(bearer(adult.accessToken)).send({ password: 'Secret123', confirm: true });
  assert.equal((await h.query('SELECT COUNT(*) n FROM account_deletion_requests WHERE username_retained IS NOT NULL'))[0].n, 2);
  assert.equal(await purgeRetainedEmails(), 0, 'nothing before the period is over');
  await h.query('UPDATE account_deletion_requests SET email_retained_until = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)');
  assert.equal(await purgeRetainedEmails(), 2);
  const rows = await h.query('SELECT email_retained, username_retained FROM account_deletion_requests');
  assert.deepEqual(rows.map((r) => [r.email_retained, r.username_retained]), [[null, null], [null, null]]);
});

test('a child deleted by the parent in the app is recorded too (source app), and the sibling is untouched', async () => {
  const { b, parent, kidA, kidB } = await family();
  const before = await snapshot(parent.account.id, kidB.id);
  const r = await api().delete(`/api/v1/profiles/${kidA.id}`).set(parent.auth).send({ pin: '1234', confirm: true });
  assert.equal(r.status, 200);
  assert.deepEqual(await snapshot(parent.account.id, kidB.id), before);
  const row = (await api().get(URL).set(bearer(b.token)).query({ status: 'completed', source: 'app' })).body.rows[0];
  assert.deepEqual({ target: row.target, username: row.username, email: row.email, by: row.decidedBy },
    { target: 'child_profile', username: 'kid_alpha', email: 'parent@example.org', by: null });
});
