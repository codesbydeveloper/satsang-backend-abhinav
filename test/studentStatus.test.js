// Part 3A: student status (Loyadham Online Classes) — app answer, admin verification, Sparks rewards.
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { api, bearer } = h;

beforeEach(h.resetDb);
after(() => h.pool.end());

const setStatus = (auth, id, body) => api().put(`/api/v1/profiles/${id}/student-status`).set(auth).send(body);
const adminAct = (token, id, action) => api().post(`/api/v1/admin/profiles/${id}/student-status`).set(bearer(token)).send({ action });
const addChild = (p, username) => api().post('/api/v1/profiles').set(p.auth)
  .send({ username, avatarId: 2, dob: h.dobYearsAgo(9, 30), parentalConsent: true });
const profileRow = async (id) => (await h.query('SELECT * FROM profiles WHERE id = ?', [id]))[0];
const rewards = (id) => h.query('SELECT reward, sparks, status, tx_id FROM profile_sparks_rewards WHERE profile_id = ? ORDER BY id', [id]);
const auditRows = (action) => h.query('SELECT * FROM audit_log WHERE action = ? ORDER BY id', [action]);

async function adult(email = 'ravi@example.org', username = 'ravi_k') {
  const b = await h.adultLogin(email, username);
  return { auth: bearer(b.accessToken), profileId: b.profiles[0].id };
}
async function fullAdmin() { return (await h.adminLogin(await h.makeAdmin('boss@example.org'))).token; }

test('new and existing profiles start as not_asked and every profile response carries studentStatus', async () => {
  const a = await adult();
  assert.equal((await profileRow(a.profileId)).student_status, 'not_asked');
  const me = await api().get('/api/v1/me').set(a.auth);
  assert.equal(me.body.profiles[0].studentStatus, 'not_asked');
  const list = await api().get('/api/v1/profiles').set(a.auth);
  assert.equal(list.body.profiles[0].studentStatus, 'not_asked');

  const p = await h.parentLogin();
  const kid = await addChild(p, 'kid_one');
  assert.equal(kid.status, 201);
  assert.equal(kid.body.profile.studentStatus, 'not_asked');
  const report = await api().get('/api/v1/parent/report').set(p.auth);
  assert.equal(report.body.children[0].studentStatus, 'not_asked');
});

test('app answers map to statuses; interested is required when not enrolled; audited without personal data', async () => {
  const a = await adult();
  let r = await setStatus(a.auth, a.profileId, { enrolled: true });
  assert.equal(r.status, 200); assert.equal(r.body.profile.studentStatus, 'pending_verification');
  const row = await profileRow(a.profileId);
  assert.ok(row.student_status_updated_at);
  r = await setStatus(a.auth, a.profileId, { enrolled: false, interested: true });
  assert.equal(r.body.profile.studentStatus, 'interested');
  r = await setStatus(a.auth, a.profileId, { enrolled: false, interested: false });
  assert.equal(r.body.profile.studentStatus, 'not_enrolled');
  r = await setStatus(a.auth, a.profileId, { enrolled: false });
  assert.equal(r.status, 400); assert.equal(r.body.error.code, 'INTERESTED_REQUIRED');
  r = await setStatus(a.auth, a.profileId, {});
  assert.equal(r.status, 400);

  const logs = await auditRows('student.status_set');
  assert.equal(logs.length, 3);
  assert.equal(logs[0].entity_type, 'profile'); assert.equal(logs[0].entity_id, String(a.profileId));
  assert.equal(logs[0].admin_id, null);
  const all = JSON.stringify(logs);
  assert.ok(!all.includes('ravi'), 'no email or username in the audit log');
});

test('a user can only set their own profiles; a parent only their own children, from the parent area or with the PIN', async () => {
  const a = await adult();
  const b = await adult('other@example.org', 'other_one');
  assert.equal((await setStatus(b.auth, a.profileId, { enrolled: true })).status, 404);

  const p = await h.parentLogin();
  const kid1 = (await addChild(p, 'kid_one')).body.profile;
  const kid2 = (await addChild(p, 'kid_two')).body.profile;
  const other = await h.parentLogin('other-parent@example.org');
  const r404 = await setStatus(other.auth, kid1.id, { enrolled: true });
  assert.equal(r404.status, 404); assert.equal(r404.body.error.code, 'PROFILE_NOT_FOUND');
  assert.equal((await setStatus(a.auth, kid1.id, { enrolled: true })).status, 404);

  // parent area: each child separately
  assert.equal((await setStatus(p.auth, kid1.id, { enrolled: true })).body.profile.studentStatus, 'pending_verification');
  assert.equal((await setStatus(p.auth, kid2.id, { enrolled: false, interested: true })).body.profile.studentStatus, 'interested');
  assert.equal((await profileRow(kid1.id)).student_status, 'pending_verification');
  assert.equal((await profileRow(kid2.id)).student_status, 'interested');

  // from a child's session: the Parent PIN is needed
  const sw = await api().post(`/api/v1/profiles/${kid1.id}/switch`).set(p.auth).send({ pin: '1234' });
  const childAuth = bearer(sw.body.accessToken);
  const noPin = await setStatus(childAuth, kid1.id, { enrolled: false, interested: false });
  assert.equal(noPin.status, 403); assert.equal(noPin.body.error.code, 'PARENT_MODE_REQUIRED');
  assert.equal((await setStatus(childAuth, kid1.id, { enrolled: false, interested: false, pin: '0000' })).status, 401);
  assert.equal((await setStatus(childAuth, kid1.id, { enrolled: false, interested: false, pin: '1234' })).body.profile.studentStatus, 'not_enrolled');
});

test('admin verify: pending → verified, +10 Sparks reserved for that exact profile, then locked for the app', async () => {
  const token = await fullAdmin();
  const p = await h.parentLogin();
  const kid1 = (await addChild(p, 'kid_one')).body.profile;
  const kid2 = (await addChild(p, 'kid_two')).body.profile;
  await setStatus(p.auth, kid1.id, { enrolled: true });
  await setStatus(p.auth, kid2.id, { enrolled: true });

  const r = await adminAct(token, kid1.id, 'verify');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { profileId: kid1.id, studentStatus: 'verified', previousStatus: 'pending_verification', sparksAwarded: 10, studentSparksAwarded: 10 });
  const row = await profileRow(kid1.id);
  assert.equal(row.student_status, 'verified');
  assert.ok(row.student_verified_by); assert.ok(row.student_verified_at);
  assert.equal(row.student_sparks_awarded, 10);
  assert.deepEqual(await rewards(kid1.id), [{ reward: 'student_verified', sparks: 10, status: 'reserved', tx_id: `student_verified-${kid1.id}` }]);
  assert.deepEqual(await rewards(kid2.id), [], 'the sibling gets nothing');
  assert.equal((await profileRow(kid2.id)).student_sparks_awarded, 0);

  const locked = await setStatus(p.auth, kid1.id, { enrolled: false, interested: false });
  assert.equal(locked.status, 409); assert.equal(locked.body.error.code, 'STUDENT_STATUS_LOCKED');

  const logs = await auditRows('student.verified');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].entity_id, String(kid1.id));
  const details = typeof logs[0].details === 'string' ? JSON.parse(logs[0].details) : logs[0].details;
  assert.deepEqual(details, { from: 'pending_verification', to: 'verified', sparksAwarded: 10 });
});

test('admin confirm_interest: interested → interest_confirmed, +5 Sparks, then locked', async () => {
  const token = await fullAdmin();
  const a = await adult();
  await setStatus(a.auth, a.profileId, { enrolled: false, interested: true });
  const r = await adminAct(token, a.profileId, 'confirm_interest');
  assert.equal(r.status, 200);
  assert.equal(r.body.studentStatus, 'interest_confirmed'); assert.equal(r.body.sparksAwarded, 5);
  assert.equal((await profileRow(a.profileId)).student_sparks_awarded, 5);
  assert.equal((await setStatus(a.auth, a.profileId, { enrolled: true })).body.error.code, 'STUDENT_STATUS_LOCKED');
  assert.equal((await auditRows('student.interest_confirmed')).length, 1);
});

test('admin reject: pending → not_enrolled without Sparks; the app can answer again', async () => {
  const token = await fullAdmin();
  const a = await adult();
  await setStatus(a.auth, a.profileId, { enrolled: true });
  const r = await adminAct(token, a.profileId, 'reject');
  assert.equal(r.status, 200);
  assert.equal(r.body.studentStatus, 'not_enrolled'); assert.equal(r.body.sparksAwarded, 0);
  assert.deepEqual(await rewards(a.profileId), []);
  assert.equal((await auditRows('student.rejected')).length, 1);
  assert.equal((await setStatus(a.auth, a.profileId, { enrolled: true })).body.profile.studentStatus, 'pending_verification');
});

test('invalid admin transitions are 409; unknown action 400; unknown profile 404', async () => {
  const token = await fullAdmin();
  const a = await adult();
  const bad = async (action, code = 'INVALID_STUDENT_TRANSITION') => {
    const r = await adminAct(token, a.profileId, action);
    assert.equal(r.status, 409, `${action}: ${JSON.stringify(r.body)}`); assert.equal(r.body.error.code, code);
  };
  // not_asked: nothing to verify / confirm / reject / reset
  for (const action of ['verify', 'confirm_interest', 'reject', 'reset']) await bad(action);
  await setStatus(a.auth, a.profileId, { enrolled: true });
  await bad('confirm_interest');
  await setStatus(a.auth, a.profileId, { enrolled: false, interested: true });
  await bad('verify'); await bad('reject');
  await setStatus(a.auth, a.profileId, { enrolled: false, interested: false });
  await bad('verify'); await bad('confirm_interest'); await bad('reject');
  assert.equal((await adminAct(token, a.profileId, 'approve')).status, 400);
  assert.equal((await adminAct(token, 999999, 'verify')).status, 404);
  assert.equal((await profileRow(a.profileId)).student_sparks_awarded, 0);
});

test('reset: back to not_asked, Sparks kept; verifying again never pays the same reward twice', async () => {
  const token = await fullAdmin();
  const a = await adult();
  await setStatus(a.auth, a.profileId, { enrolled: true });
  assert.equal((await adminAct(token, a.profileId, 'verify')).body.sparksAwarded, 10);
  // verifying a verified profile again is refused
  assert.equal((await adminAct(token, a.profileId, 'verify')).status, 409);

  const reset = await adminAct(token, a.profileId, 'reset');
  assert.equal(reset.status, 200);
  assert.equal(reset.body.studentStatus, 'not_asked'); assert.equal(reset.body.studentSparksAwarded, 10);
  let row = await profileRow(a.profileId);
  assert.equal(row.student_status, 'not_asked'); assert.equal(row.student_sparks_awarded, 10);
  assert.equal(row.student_verified_by, null);
  assert.equal((await auditRows('student.reset')).length, 1);

  await setStatus(a.auth, a.profileId, { enrolled: true });
  const again = await adminAct(token, a.profileId, 'verify');
  assert.equal(again.status, 200);
  assert.equal(again.body.studentStatus, 'verified'); assert.equal(again.body.sparksAwarded, 0); assert.equal(again.body.studentSparksAwarded, 10);
  assert.equal((await rewards(a.profileId)).length, 1);
  assert.equal((await profileRow(a.profileId)).student_sparks_awarded, 10);

  // the other reward is separate: reset → interested → confirm gives +5 once
  await adminAct(token, a.profileId, 'reset');
  await setStatus(a.auth, a.profileId, { enrolled: false, interested: true });
  assert.equal((await adminAct(token, a.profileId, 'confirm_interest')).body.sparksAwarded, 5);
  await adminAct(token, a.profileId, 'reset');
  await setStatus(a.auth, a.profileId, { enrolled: false, interested: true });
  assert.equal((await adminAct(token, a.profileId, 'confirm_interest')).body.sparksAwarded, 0);
  row = await profileRow(a.profileId);
  assert.equal(row.student_sparks_awarded, 15);
  assert.equal((await rewards(a.profileId)).length, 2);
});

test('two simultaneous verifications award the Sparks once', async () => {
  const token = await fullAdmin();
  const a = await adult();
  await setStatus(a.auth, a.profileId, { enrolled: true });
  const rs = await Promise.all([adminAct(token, a.profileId, 'verify'), adminAct(token, a.profileId, 'verify'), adminAct(token, a.profileId, 'verify')]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409, 409]);
  assert.equal((await rewards(a.profileId)).length, 1);
  assert.equal((await profileRow(a.profileId)).student_sparks_awarded, 10);
});

test('Content Editor gets 403 on the action, the user list and the user detail', async () => {
  const a = await adult();
  await setStatus(a.auth, a.profileId, { enrolled: true });
  const editor = (await h.adminLogin(await h.makeAdmin('editor@example.org', 'content_editor'))).token;
  const r = await adminAct(editor, a.profileId, 'verify');
  assert.equal(r.status, 403); assert.equal(r.body.error.code, 'ROLE_FORBIDDEN');
  assert.equal((await api().get('/api/v1/admin/users?studentStatus=pending_verification').set(bearer(editor))).status, 403);
  const accountId = (await profileRow(a.profileId)).account_id;
  assert.equal((await api().get(`/api/v1/admin/users/${accountId}`).set(bearer(editor))).status, 403);
  assert.equal((await profileRow(a.profileId)).student_status, 'pending_verification');
  assert.equal((await api().post(`/api/v1/admin/profiles/${a.profileId}/student-status`).send({ action: 'verify' })).status, 401);
});

test('admin users list: studentStatus per profile and ?studentStatus= filter; detail carries the student fields', async () => {
  const token = await fullAdmin();
  const a = await adult();
  const b = await adult('other@example.org', 'other_one');
  const p = await h.parentLogin();
  const kid1 = (await addChild(p, 'kid_one')).body.profile;
  const kid2 = (await addChild(p, 'kid_two')).body.profile;
  await setStatus(a.auth, a.profileId, { enrolled: true });
  await setStatus(p.auth, kid1.id, { enrolled: true });
  await setStatus(p.auth, kid2.id, { enrolled: false, interested: true });

  const all = await api().get('/api/v1/admin/users').set(bearer(token));
  assert.equal(all.status, 200);
  const byProfile = Object.fromEntries(all.body.rows.map((r) => [r.profileId, r.studentStatus]));
  assert.equal(byProfile[a.profileId], 'pending_verification');
  assert.equal(byProfile[b.profileId], 'not_asked');
  assert.equal(byProfile[kid2.id], 'interested');

  const pending = await api().get('/api/v1/admin/users?studentStatus=pending_verification').set(bearer(token));
  assert.deepEqual(pending.body.rows.map((r) => r.profileId).sort(), [a.profileId, kid1.id].sort());
  assert.equal(pending.body.totalAccounts, 2);
  const interested = await api().get('/api/v1/admin/users?studentStatus=interested').set(bearer(token));
  assert.deepEqual(interested.body.rows.map((r) => r.profileId), [kid2.id]);
  const withQ = await api().get('/api/v1/admin/users?studentStatus=pending_verification&q=kid_').set(bearer(token));
  assert.deepEqual(withQ.body.rows.map((r) => r.profileId), [kid1.id]);
  assert.equal((await api().get('/api/v1/admin/users?studentStatus=bogus').set(bearer(token))).status, 400);
  // comma list: the dashboard's "Students to verify" (pending + interested)
  const toVerify = await api().get('/api/v1/admin/users?studentStatus=pending_verification,interested').set(bearer(token));
  assert.equal(toVerify.status, 200);
  assert.deepEqual(toVerify.body.rows.map((r) => r.profileId).sort(), [a.profileId, kid1.id, kid2.id].sort());
  assert.equal(toVerify.body.totalAccounts, 2);
  assert.equal((await api().get('/api/v1/admin/users?studentStatus=interested,bogus').set(bearer(token))).status, 400);
  assert.equal((await api().get('/api/v1/admin/users?studentStatus=,').set(bearer(token))).status, 400);
  const dash = (await api().get('/api/v1/admin/dashboard').set(bearer(token))).body.totals;
  assert.deepEqual([dash.studentsToVerify, dash.studentsPendingVerification, dash.studentsInterested], [3, 2, 1]);

  await adminAct(token, kid1.id, 'verify');
  const parentAccountId = (await profileRow(kid1.id)).account_id;
  const detail = await api().get(`/api/v1/admin/users/${parentAccountId}`).set(bearer(token));
  const k1 = detail.body.profiles.find((x) => x.id === kid1.id);
  assert.equal(k1.studentStatus, 'verified');
  assert.equal(k1.studentSparksAwarded, 10);
  assert.ok(k1.studentVerifiedBy); assert.match(k1.studentVerifiedAt, /Z$/); assert.match(k1.studentStatusUpdatedAt, /Z$/);
  assert.ok(k1.studentVerifiedByName, 'the verifying admin is named');
  const k2 = detail.body.profiles.find((x) => x.id === kid2.id);
  assert.equal(k2.studentStatus, 'interested'); assert.equal(k2.studentVerifiedByName, null);
});

test('public config: studentInterestFormUrl (empty by default) and the reward amounts', async () => {
  const r = await api().get('/api/v1/meta/config');
  assert.equal(r.status, 200);
  assert.equal(r.body.studentInterestFormUrl, '');
  assert.deepEqual(r.body.studentSparks, { verified: 10, interestConfirmed: 5 });
});

test('deleting a child profile removes its reserved rewards', async () => {
  const token = await fullAdmin();
  const p = await h.parentLogin();
  const kid = (await addChild(p, 'kid_one')).body.profile;
  await setStatus(p.auth, kid.id, { enrolled: true });
  await adminAct(token, kid.id, 'verify');
  assert.equal((await rewards(kid.id)).length, 1);
  const del = await api().delete(`/api/v1/profiles/${kid.id}`).set(p.auth).send({ pin: '1234', confirm: true });
  assert.equal(del.status, 200);
  assert.equal((await rewards(kid.id)).length, 0);
});
