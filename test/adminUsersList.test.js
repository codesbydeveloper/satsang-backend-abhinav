// Admin Panel Users table (client 23 Nov 2026): GET /admin/users returns one row per playable profile grouped by
// account (account row first, then its children), with filters, sorting that keeps families together, and DOB for
// Full Admins only.
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { api, bearer } = h;

beforeEach(h.resetDb);
after(() => h.pool.end());

const setStatus = (auth, id, body) => api().put(`/api/v1/profiles/${id}/student-status`).set(auth).send(body);
const addChild = async (p, username, years) => {
  const r = await api().post('/api/v1/profiles').set(p.auth).send({ username, avatarId: 2, dob: h.dobYearsAgo(years, 30), parentalConsent: true });
  if (r.status !== 201) throw new Error('child failed: ' + JSON.stringify(r.body));
  return r.body.profile;
};
const setName = (accountId, first, last) => h.query('UPDATE accounts SET first_name = ?, last_name = ? WHERE id = ?', [first, last, accountId]);
const setCountry = (profileId, c) => h.query('UPDATE profiles SET country = ? WHERE id = ?', [c, profileId]);

// Three families: Anil (adult, IN), Zara (adult, US), Priya (parent) with kid_a (12, IN, pending) and kid_b (9, GB, interested).
async function seed() {
  const anil = await h.adultLogin('anil@example.org', 'anil_a');
  const zara = await h.adultLogin('zara@example.org', 'zara_z');
  const p = await h.parentLogin('parent@example.org');
  const kidA = await addChild(p, 'kid_a', 12);
  const kidB = await addChild(p, 'kid_b', 9);
  await setName(anil.account.id, 'Anil', 'Shah'); await setName(zara.account.id, 'Zara', 'Ali'); await setName(p.account.id, 'Priya', 'Mehta');
  await setCountry(anil.profiles[0].id, 'IN'); await setCountry(zara.profiles[0].id, 'US');
  await setCountry(kidA.id, 'IN'); await setCountry(kidB.id, 'GB');
  await setStatus(p.auth, kidA.id, { enrolled: true });
  await setStatus(p.auth, kidB.id, { enrolled: false, interested: true });
  const token = (await h.adminLogin(await h.makeAdmin('boss@example.org'))).token;
  return { token, anil, zara, p, kidA, kidB };
}
const list = async (token, params = {}) => {
  const r = await api().get('/api/v1/admin/users').set(bearer(token)).query(params);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
const names = (body) => body.rows.map((r) => r.username || `(${r.name})`);
const hits = (body) => body.rows.filter((r) => r.matched).map((r) => r.username || `(${r.name})`);

test('one row per profile, grouped: account row first, then each child with parentAccountId and the parent email', async () => {
  const s = await seed();
  const b = await list(s.token);
  assert.equal(b.totalAccounts, 3);
  assert.deepEqual(b.countries, ['GB', 'IN', 'US']);
  assert.equal(b.rows.length, 5);
  // newest family first (joined desc); the parent family keeps its children right under it
  assert.equal(b.rows[0].accountType, 'parent');
  assert.deepEqual(b.rows.slice(1, 3).map((r) => r.accountType), ['child', 'child']);
  const parent = b.rows[0];
  assert.equal(parent.profileId, null);
  assert.equal(parent.name, 'Priya Mehta');
  assert.equal(parent.email, 'parent@example.org'); assert.equal(parent.isParentEmail, false);
  assert.equal(parent.dob, null); assert.equal(parent.studentStatus, null);
  const kid = b.rows.find((r) => r.username === 'kid_b');
  assert.equal(kid.parentAccountId, s.p.account.id);
  assert.equal(kid.accountId, s.p.account.id);
  assert.equal(kid.profileId, s.kidB.id);
  assert.equal(kid.isChild, true);
  assert.equal(kid.name, null, 'child profiles have no name');
  assert.equal(kid.email, 'parent@example.org'); assert.equal(kid.isParentEmail, true);
  assert.equal(kid.country, 'GB');
  assert.equal(kid.dob, h.dobYearsAgo(9, 30));
  assert.equal(kid.ageGroup, 'Bals/Balikas B'); assert.equal(kid.ageGroupKey, 'Bals/Balikas B');
  assert.equal(kid.studentStatus, 'interested');
  assert.equal(kid.emailVerified, true);
  assert.match(kid.joined, /Z$/);
  const anil = b.rows.find((r) => r.username === 'anil_a');
  assert.deepEqual([anil.accountType, anil.name, anil.country, anil.parentAccountId, anil.isParentEmail, anil.studentStatus],
    ['adult', 'Anil Shah', 'IN', null, false, 'not_asked']);
  assert.equal(anil.dob, h.dobYearsAgo(30));
  assert.equal(anil.ageGroup, 'Yuvaks/Yuvatis A', 'the label, not the key');
  assert.ok(b.rows.every((r) => r.matched), 'no filter: every row matches');
  assert.equal(/password|pin_hash|gender/i.test(JSON.stringify(b)), false);
});

// The account-level DOB is never returned by the app (test/registerDob.test.js, unchanged); the public username check never
// shows one. This list adds DOB for Full Admins only.
test('the DOB is only on the Full Admin list: not in the public username check, Content Editors get 403', async () => {
  const s = await seed();
  const check = await api().get('/api/v1/usernames/check').query({ username: 'kid_a' });
  assert.equal(check.status, 200);
  assert.equal(JSON.stringify(check.body).includes(h.dobYearsAgo(12, 30)), false);
  assert.equal(JSON.stringify(check.body).includes('dob'), false);
  const ed = (await h.adminLogin(await h.makeAdmin('ed@example.org', 'content_editor'))).token;
  assert.equal((await api().get('/api/v1/admin/users').set(bearer(ed))).status, 403);
  assert.equal((await api().get('/api/v1/admin/users').query({ sort: 'dob' }).set(bearer(ed))).status, 403);
});

test('sort by username / name: families by their account row (empty last), children ordered inside', async () => {
  const s = await seed();
  assert.deepEqual(names(await list(s.token, { sort: 'username' })), ['anil_a', 'zara_z', '(Priya Mehta)', 'kid_a', 'kid_b']);
  assert.deepEqual(names(await list(s.token, { sort: 'username', order: 'desc' })), ['zara_z', 'anil_a', '(Priya Mehta)', 'kid_b', 'kid_a']);
  assert.deepEqual(names(await list(s.token, { sort: 'name' })), ['anil_a', '(Priya Mehta)', 'kid_a', 'kid_b', 'zara_z']);
  assert.deepEqual(names(await list(s.token, { sort: 'name', order: 'desc' })), ['zara_z', '(Priya Mehta)', 'kid_a', 'kid_b', 'anil_a']);
  const email = await list(s.token, { sort: 'email' });
  assert.deepEqual(names(email), ['anil_a', '(Priya Mehta)', 'kid_a', 'kid_b', 'zara_z']);
  const type = await list(s.token, { sort: 'accountType' });
  assert.deepEqual(type.rows.map((r) => r.accountType), ['adult', 'adult', 'parent', 'child', 'child']);
});

test('sort by age group, DOB, country and joined keeps children under their parent', async () => {
  const s = await seed();
  // age groups in age order (not A→Z); kid_b (9) before kid_a (12) inside the family
  assert.deepEqual(names(await list(s.token, { sort: 'ageGroup' })).slice(2), ['(Priya Mehta)', 'kid_b', 'kid_a']);
  assert.deepEqual(names(await list(s.token, { sort: 'ageGroup', order: 'desc' })).slice(2), ['(Priya Mehta)', 'kid_a', 'kid_b']);
  assert.deepEqual(names(await list(s.token, { sort: 'dob', order: 'desc' })).slice(2), ['(Priya Mehta)', 'kid_b', 'kid_a']);
  assert.deepEqual(names(await list(s.token, { sort: 'country' })), ['anil_a', 'zara_z', '(Priya Mehta)', 'kid_b', 'kid_a']);
  const joined = await list(s.token, { sort: 'joined', order: 'asc' });
  assert.equal(joined.order, 'asc');
  assert.deepEqual(names(joined).slice(0, 2), ['anil_a', 'zara_z']);
});

// Sparks column (chunk 2.2B fix): every profile row carries its real balance from profile_sparks.
const adjust = (token, profileId, amount) => api().post(`/api/v1/admin/profiles/${profileId}/sparks/adjust`).set(bearer(token)).send({ amount, reason: 'Test adjustment' });
const balanceOf = async (token, profileId) => (await api().get(`/api/v1/admin/profiles/${profileId}/sparks`).set(bearer(token))).body.balance;

test('sparksBalance: the ledger balance on every profile row, 0 without Sparks, null on a parent account row', async () => {
  const s = await seed();
  // a profile that never had Sparks has no profile_sparks row at all: still 0
  await h.query('DELETE FROM sparks_transactions WHERE profile_id = ?', [s.kidB.id]);
  await h.query('DELETE FROM profile_sparks WHERE profile_id = ?', [s.kidB.id]);
  assert.equal((await adjust(s.token, s.anil.profiles[0].id, 40)).status, 201);
  const b = await list(s.token);
  const row = (u) => b.rows.find((r) => r.username === u);
  for (const [u, id] of [['anil_a', s.anil.profiles[0].id], ['zara_z', s.zara.profiles[0].id], ['kid_a', s.kidA.id]]) {
    assert.equal(typeof row(u).sparksBalance, 'number', u);
    assert.equal(row(u).sparksBalance, await balanceOf(s.token, id), `${u} equals GET /admin/profiles/:id/sparks`);
  }
  assert.equal(row('anil_a').sparksBalance, row('zara_z').sparksBalance + 40);
  assert.equal(row('kid_b').sparksBalance, 0);
  const parent = b.rows.find((r) => r.accountType === 'parent');
  assert.equal(parent.profileId, null);
  assert.equal(parent.sparksBalance, null);
});

test('sort=sparks: families by their account row (parent rows have none → last), children by balance inside; default most first', async () => {
  const s = await seed();
  const set = (id, n) => h.query(
    'INSERT INTO profile_sparks (profile_id, balance, lifetime_earned) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE balance = VALUES(balance), lifetime_earned = VALUES(lifetime_earned)', [id, n, n]);
  await set(s.anil.profiles[0].id, 300); await set(s.zara.profiles[0].id, 50); await set(s.kidA.id, 10); await set(s.kidB.id, 80);
  const desc = await list(s.token, { sort: 'sparks' });
  assert.equal(desc.order, 'desc');
  assert.deepEqual(names(desc), ['anil_a', 'zara_z', '(Priya Mehta)', 'kid_b', 'kid_a']);
  assert.deepEqual(desc.rows.map((r) => r.sparksBalance), [300, 50, null, 80, 10]);
  const asc = await list(s.token, { sort: 'sparks', order: 'asc' });
  assert.deepEqual(names(asc), ['zara_z', 'anil_a', '(Priya Mehta)', 'kid_a', 'kid_b']);
  // filters still keep the family together
  assert.deepEqual(names(await list(s.token, { sort: 'sparks', accountType: 'child' })), ['(Priya Mehta)', 'kid_b', 'kid_a']);
});

test('filters: a matching child brings its parent row (matched: false) above it', async () => {
  const s = await seed();
  const gb = await list(s.token, { country: 'gb' });
  assert.deepEqual(names(gb), ['(Priya Mehta)', 'kid_b']);
  assert.deepEqual(gb.rows.map((r) => r.matched), [false, true]);
  assert.equal(gb.totalAccounts, 1);
  assert.deepEqual(names(await list(s.token, { country: 'IN', sort: 'username' })), ['anil_a', '(Priya Mehta)', 'kid_a']);

  assert.deepEqual(names(await list(s.token, { accountType: 'child', sort: 'username' })), ['(Priya Mehta)', 'kid_a', 'kid_b']);
  assert.deepEqual(names(await list(s.token, { accountType: 'adult', sort: 'username' })), ['anil_a', 'zara_z']);
  assert.deepEqual(hits(await list(s.token, { accountType: 'parent' })), ['(Priya Mehta)']);
  assert.deepEqual(names(await list(s.token, { ageGroup: 'Bals/Balikas C' })), ['(Priya Mehta)', 'kid_a']);
});

test('classStatus: verified | pending_verification | interested | not_enrolled; the old studentStatus still works', async () => {
  const s = await seed();
  assert.deepEqual(names(await list(s.token, { classStatus: 'pending_verification' })), ['(Priya Mehta)', 'kid_a']);
  assert.deepEqual(names(await list(s.token, { classStatus: 'interested' })), ['(Priya Mehta)', 'kid_b']);
  assert.deepEqual(names(await list(s.token, { classStatus: 'not_enrolled', sort: 'username' })), ['anil_a', 'zara_z'], 'never answered counts as not enrolled');
  assert.deepEqual((await list(s.token, { classStatus: 'verified' })).rows, []);
  assert.equal((await list(s.token, { classStatus: 'all' })).rows.length, 5);
  assert.deepEqual(names(await list(s.token, { studentStatus: 'pending_verification,interested', sort: 'username' })), ['(Priya Mehta)', 'kid_a', 'kid_b']);
  // filters combine
  assert.deepEqual((await list(s.token, { classStatus: 'interested', country: 'IN' })).rows, []);
});

test('search q: name, username or email', async () => {
  const s = await seed();
  assert.deepEqual(names(await list(s.token, { q: 'zara ali' })), ['zara_z']);
  assert.deepEqual(names(await list(s.token, { q: 'ANIL_' })), ['anil_a']);
  const fam = await list(s.token, { q: 'parent@', sort: 'username' });
  assert.deepEqual(names(fam), ['(Priya Mehta)', 'kid_a', 'kid_b'], "a child's row carries the parent email");
  assert.ok(fam.rows.every((r) => r.matched));
  const kid = await list(s.token, { q: 'kid_b' });
  assert.deepEqual(names(kid), ['(Priya Mehta)', 'kid_b']);
  assert.deepEqual(kid.rows.map((r) => r.matched), [false, true]);
  assert.deepEqual((await list(s.token, { q: '100%_' })).rows, [], 'LIKE wildcards are literal');
});

test('pages count families, never split one', async () => {
  const s = await seed();
  const p1 = await list(s.token, { sort: 'username', pageSize: 2, page: 1 });
  const p2 = await list(s.token, { sort: 'username', pageSize: 2, page: 2 });
  assert.equal(p1.totalAccounts, 3);
  assert.deepEqual(names(p1), ['anil_a', 'zara_z']);
  assert.deepEqual(names(p2), ['(Priya Mehta)', 'kid_a', 'kid_b']);
  assert.deepEqual((await list(s.token, { page: 9 })).rows, []);
});

test('bad parameters are 400', async () => {
  const s = await seed();
  for (const q of [{ sort: 'password' }, { order: 'up' }, { classStatus: 'enrolled' }, { accountType: 'kid' }, { ageGroup: 'Teens' }, { country: 'IND' }]) {
    assert.equal((await api().get('/api/v1/admin/users').set(bearer(s.token)).query(q)).status, 400, JSON.stringify(q));
  }
});

test('Users is view only: POST /admin/users (create an app user) is not available (404), nothing is created', async () => {
  const token = (await h.adminLogin(await h.makeAdmin('boss@example.org'))).token;
  const before = (await h.query('SELECT COUNT(*) AS n FROM accounts'))[0].n;
  const r = await api().post('/api/v1/admin/users').set(bearer(token))
    .send({ email: 'new@example.org', password: 'secret123', accountType: 'adult', language: 'en', mode: 'satsang' });
  assert.equal(r.status, 404);
  assert.equal((await h.query('SELECT COUNT(*) AS n FROM accounts'))[0].n, before);
  // the docs list no POST for /admin/users either
  assert.equal((await api().get('/api-docs.json')).body.paths['/admin/users'].post, undefined);
});
