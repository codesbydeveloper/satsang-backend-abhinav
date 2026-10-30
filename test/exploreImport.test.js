// Explore → account: POST /me/explore-import (client, 30 Oct 2026). Once per account, idempotent by transaction id,
// entries stored as 'pending_import' (nothing credited before Milestone 2/3).
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const h = require('./helpers');
const { api, bearer } = h;

beforeEach(h.resetDb);
after(() => h.pool.end());

/** Independent Sign Up (dob only) + verify + Profile setup; returns the profile session. */
async function independentWithProfile(email = 'meera@example.org', username = 'lotus_star') {
  const reg = await api().post('/api/v1/auth/register')
    .send({ ...h.NAMES, email, password: 'Secret123', accountType: 'adult', acceptPrivacyPolicy: true, dob: h.dobYearsAgo(25) });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const v = (await api().post('/api/v1/auth/verify-email').send({ email, code: h.lastCode(email) })).body;
  const p = await api().post('/api/v1/me/profile').set(bearer(v.accessToken)).send({ username, avatarId: 4, mode: 'satsang', country: 'IN' });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  return { auth: bearer(p.body.accessToken), profileId: p.body.profile.id };
}

const at = '2026-10-29T09:00:00Z';
const record = () => ({
  avatarId: 9,
  mode: 'sanatan',
  sparks: [{ txId: randomUUID(), amount: 10, reason: 'quiz_correct', at }, { txId: randomUUID(), amount: 5, reason: 'daily_visit', at }],
  purchases: [{ txId: randomUUID(), itemId: 'crown_gold', sparks: 8, at }],
  scores: [{ txId: randomUUID(), game: 'quiz', itemId: 'quiz_1', score: 7, at }],
  progress: [{ txId: randomUUID(), area: 'learn', itemId: 'lesson_1', value: 100, at }],
});
const send = (auth, b) => api().post('/api/v1/me/explore-import').set(auth).send(b);

test('independent: entries stored as pending_import, avatar and path applied, nothing credited', async () => {
  const s = await independentWithProfile();
  const r = await send(s.auth, record());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { profileId: s.profileId, firstImport: true, imported: 5, duplicates: 0, pending: { sparks: 15, purchases: 1, scores: 1, progress: 1 } });
  const p = (await h.query('SELECT avatar_id, mode FROM profiles WHERE id = ?', [s.profileId]))[0];
  assert.equal(p.avatar_id, 9);
  assert.equal(p.mode, 'sanatan');
  const rows = await h.query('SELECT status, COUNT(*) AS n FROM explore_import_items GROUP BY status');
  assert.deepEqual(rows.map((x) => [x.status, Number(x.n)]), [['pending_import', 5]]);
  assert.equal((await h.query('SELECT status FROM signup_bonuses'))[0].status, 'pending', 'the 100 sign-up Sparks are untouched');
});

test('idempotent: the same transaction ids again count as duplicates (a retry after a lost response)', async () => {
  const s = await independentWithProfile();
  const b = record();
  assert.equal((await send(s.auth, b)).status, 200);
  const again = await send(s.auth, b);
  assert.equal(again.status, 200);
  assert.equal(again.body.firstImport, false);
  assert.equal(again.body.imported, 0);
  assert.equal(again.body.duplicates, 5);
  assert.equal(again.body.pending.sparks, 15, 'never counted twice');
  assert.equal(Number((await h.query('SELECT items FROM explore_imports'))[0].items), 5);
});

test('batches: a later call for the same profile adds new entries; avatar/path only on the first call', async () => {
  const s = await independentWithProfile();
  assert.equal((await send(s.auth, record())).status, 200);
  const more = await send(s.auth, { avatarId: 1, mode: 'satsang', sparks: [{ txId: randomUUID(), amount: 3, reason: 'quiz_correct', at }] });
  assert.equal(more.status, 200);
  assert.equal(more.body.imported, 1);
  assert.equal(more.body.pending.sparks, 18);
  const p = (await h.query('SELECT avatar_id, mode FROM profiles WHERE id = ?', [s.profileId]))[0];
  assert.deepEqual([p.avatar_id, p.mode], [9, 'sanatan'], 'the first import decided');
});

test('a transaction id another account already used is never stored twice', async () => {
  const a = await independentWithProfile('a@example.org', 'first_one');
  const b = await independentWithProfile('b@example.org', 'second_one');
  const body = record();
  assert.equal((await send(a.auth, body)).body.imported, 5);
  const r = await send(b.auth, body);
  assert.equal(r.status, 200);
  assert.equal(r.body.imported, 0);
  assert.equal(r.body.duplicates, 5);
});

test('an independent account needs its profile first (409 PROFILE_REQUIRED)', async () => {
  const email = 'x@example.org';
  await api().post('/api/v1/auth/register').send({ ...h.NAMES, email, password: 'Secret123', accountType: 'adult', acceptPrivacyPolicy: true, dob: h.dobYearsAgo(25) });
  const v = (await api().post('/api/v1/auth/verify-email').send({ email, code: h.lastCode(email) })).body;
  const r = await send(bearer(v.accessToken), record());
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'PROFILE_REQUIRED');
});

test('parent: into one child from the parent area; once per account (another child → 409)', async () => {
  const p = await h.parentLogin();
  const kid = (await api().post('/api/v1/profiles').set(p.auth)
    .send({ username: 'kid_aaa', avatarId: 2, dob: h.dobYearsAgo(8), parentalConsent: true, pin: '1234' })).body.profile;
  const kid2 = (await api().post('/api/v1/profiles').set(p.auth)
    .send({ username: 'kid_bbb', avatarId: 3, dob: h.dobYearsAgo(9), parentalConsent: true, pin: '1234' })).body.profile;

  const missing = await send(p.auth, record());
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, 'PROFILE_ID_REQUIRED');

  const r = await send(p.auth, { ...record(), profileId: kid.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.profileId, kid.id);
  assert.equal((await h.query('SELECT avatar_id FROM profiles WHERE id = ?', [kid.id]))[0].avatar_id, 9);

  const other = await send(p.auth, { ...record(), profileId: kid2.id });
  assert.equal(other.status, 409);
  assert.equal(other.body.error.code, 'EXPLORE_ALREADY_IMPORTED');

  // from a child's session: parent area only
  const asKid = bearer((await api().post('/api/v1/me/active-profile').set(p.auth).send({ profileId: kid.id })).body.accessToken);
  const fromChild = await send(asKid, { ...record(), profileId: kid.id });
  assert.equal(fromChild.status, 403);
  assert.equal(fromChild.body.error.code, 'PARENT_MODE_REQUIRED');
});

test('parent: someone else\'s profile is not found', async () => {
  const s = await independentWithProfile();
  const p = await h.parentLogin();
  const r = await send(p.auth, { ...record(), profileId: s.profileId });
  assert.equal(r.status, 404);
});

test('validation: UUID transaction ids, codes only (no free text), at most 200 entries, no future times', async () => {
  const s = await independentWithProfile();
  const bad = [
    { sparks: [{ txId: 'not-a-uuid', amount: 1, reason: 'quiz', at }] },
    { sparks: [{ txId: randomUUID(), amount: 0, reason: 'quiz', at }] },
    { sparks: [{ txId: randomUUID(), amount: 1, reason: 'Hello Radha!', at }] },
    { scores: [{ txId: randomUUID(), game: 'quiz', score: -1, at }] },
    { progress: [{ txId: randomUUID(), area: 'learn', itemId: 'x', value: 1, at: '2099-01-01T00:00:00Z' }] },
    { sparks: Array.from({ length: 201 }, () => ({ txId: randomUUID(), amount: 1, reason: 'quiz', at })) },
    { sparks: Array.from({ length: 150 }, () => ({ txId: randomUUID(), amount: 1, reason: 'quiz', at })),
      scores: Array.from({ length: 51 }, () => ({ txId: randomUUID(), game: 'quiz', score: 1, at })) },
  ];
  for (const b of bad) {
    const r = await send(s.auth, b);
    assert.equal(r.status, 400, JSON.stringify(b).slice(0, 80));
    assert.equal(r.body.error.code, 'VALIDATION_ERROR');
  }
  assert.equal(Number((await h.query('SELECT COUNT(*) AS n FROM explore_import_items'))[0].n), 0);
});

test('deleting the account deletes its Explore import', async () => {
  const s = await independentWithProfile();
  await send(s.auth, record());
  const d = await api().delete('/api/v1/me').set(s.auth).send({ password: 'Secret123', confirm: true });
  assert.equal(d.status, 200);
  assert.equal(Number((await h.query('SELECT COUNT(*) AS n FROM explore_import_items'))[0].n), 0);
  assert.equal(Number((await h.query('SELECT COUNT(*) AS n FROM explore_imports'))[0].n), 0);
});

test('/api-docs lists POST /me/explore-import', async () => {
  const r = await api().get('/api-docs.json');
  assert.ok(r.body.paths['/me/explore-import'].post);
});
