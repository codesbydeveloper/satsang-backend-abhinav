// Sign Up fields (client change, Oct 2026): first name, last name, gender for both account types; the age gate runs
// before anything else; "Receive 100 Sparks" reserved at email verification; private details only for the owner.
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const config = require('../src/config');
const { api, bearer, query } = h;

beforeEach(h.resetDb);
after(() => h.pool.end());

const independent = (extra = {}) => ({
  email: 'meera@example.org', password: 'Secret123', accountType: 'adult', acceptPrivacyPolicy: true,
  firstName: 'Meera', lastName: 'Patel', gender: 'female', dob: h.dobYearsAgo(25), ...extra });
const parent = (extra = {}) => ({
  email: 'parent@example.org', password: 'Secret123', accountType: 'parent', acceptPrivacyPolicy: true, confirmAdult: true,
  firstName: 'Kiran', lastName: 'Shah', gender: 'prefer_not_to_say', ...extra });

const register = (b) => api().post('/api/v1/auth/register').send(b);
const verify = (email) => api().post('/api/v1/auth/verify-email').send({ email, code: h.lastCode(email) });
const fieldsOf = (r) => (r.body.error.details || []).map((d) => d.field);

test('independent and parent register store first name, last name and gender', async () => {
  assert.equal((await register(independent())).status, 201);
  assert.equal((await register(parent())).status, 201);
  const rows = await query('SELECT email, first_name, last_name, gender FROM accounts ORDER BY id');
  assert.deepEqual(rows.map((r) => [r.first_name, r.last_name, r.gender]),
    [['Meera', 'Patel', 'female'], ['Kiran', 'Shah', 'prefer_not_to_say']]);
});

test('names and gender are required for both account types', async () => {
  for (const make of [independent, parent]) {
    const r = await register(make({ firstName: undefined, lastName: undefined, gender: undefined }));
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'VALIDATION_ERROR');
    for (const f of ['firstName', 'lastName', 'gender']) assert.ok(fieldsOf(r).includes(f), `${make.name}: ${f}`);
  }
  assert.deepEqual(fieldsOf(await register(parent({ gender: 'other' }))), ['gender']);
  assert.ok(fieldsOf(await register(parent({ confirmAdult: undefined }))).includes('confirmAdult'), 'parents still confirm 18+');
  assert.ok(fieldsOf(await register(independent({ dob: undefined }))).includes('dob'), 'independent still needs the dob');
  assert.equal((await query('SELECT COUNT(*) AS n FROM accounts'))[0].n, 0);
});

test('names: letters (any script), spaces, - and \' only, 1–50 characters, trimmed', async () => {
  const bad = ['', '   ', 'R@vi', 'Ravi2', 'a'.repeat(51), "--'", 'Ravi_K', '<b>'];
  for (const name of bad) {
    const r = await register(independent({ firstName: name }));
    assert.equal(r.status, 400, JSON.stringify(name));
    assert.deepEqual(fieldsOf(r), ['firstName'], JSON.stringify(name));
  }
  const good = [['  Anne-Marie  ', 'Anne-Marie'], ["O'Brien", "O'Brien"], ['D’Souza', "D'Souza"], ['રવિ', 'રવિ'],
    ['Mary Jane', 'Mary Jane'], ['a'.repeat(50), 'a'.repeat(50)]];
  let i = 0;
  for (const [name, stored] of good) {
    const email = `g${i++}@example.org`;
    assert.equal((await register(independent({ email, lastName: name }))).status, 201, name);
    assert.equal((await query('SELECT last_name FROM accounts WHERE email = ?', [email]))[0].last_name, stored);
  }
});

test('under the consent age: PARENT_ACCOUNT_REQUIRED before any other field is validated, nothing stored', async () => {
  const young = h.dobYearsAgo(config.parentalConsentAge - 1);
  // every other field is wrong or missing: the age gate still answers first
  const r = await register({ accountType: 'adult', dob: young, firstName: 'R@vi', email: 'not-an-email', password: 'x' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'PARENT_ACCOUNT_REQUIRED');
  assert.equal(r.body.error.details, undefined, 'no field errors are revealed');
  // an email that is already registered is not revealed either
  await register(parent());
  const taken = await register(independent({ email: 'parent@example.org', dob: young }));
  assert.equal(taken.body.error.code, 'PARENT_ACCOUNT_REQUIRED');
  assert.equal((await query('SELECT COUNT(*) AS n FROM accounts'))[0].n, 1, 'only the parent');
  assert.equal(h.outbox.filter((m) => m.to === 'meera@example.org').length, 0);
});

test('email verification reserves 100 Sparks once; GET /me shows it to the owner', async () => {
  await register(independent());
  assert.equal((await query('SELECT COUNT(*) AS n FROM signup_bonuses'))[0].n, 0, 'nothing before verification');
  const v = await verify('meera@example.org');
  assert.equal(v.status, 200);
  const me = await api().get('/api/v1/me').set(bearer(v.body.accessToken));
  assert.equal(me.status, 200);
  assert.deepEqual(me.body.account.signupBonus, { sparks: 100, status: 'pending' });
  assert.equal(me.body.account.firstName, 'Meera');
  assert.equal(me.body.account.lastName, 'Patel');
  assert.equal(me.body.account.gender, 'female');

  // a second verification (new code after a resend) and a login never add a second bonus
  await api().post('/api/v1/auth/resend-code').send({ email: 'meera@example.org' });
  await api().post('/api/v1/auth/login').send({ email: 'meera@example.org', password: 'Secret123' });
  const rows = await query('SELECT sparks, status, credited_at FROM signup_bonuses');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sparks, 100);
  assert.equal(rows[0].credited_at, null, 'credited in Milestone 2');

  const p = await h.parentLogin('kiran@example.org');
  const pm = await api().get('/api/v1/me').set(p.auth);
  assert.deepEqual(pm.body.account.signupBonus, { sparks: 100, status: 'pending' }, 'parent accounts too');
});

test('name and gender are private: only GET /me and the admin user detail return them', async () => {
  await register(independent());
  const v = await verify('meera@example.org');
  const login = await api().post('/api/v1/auth/login').send({ email: 'meera@example.org', password: 'Secret123' });
  const refresh = await api().post('/api/v1/auth/refresh').send({ refreshToken: login.body.refreshToken });
  for (const [what, body] of [['verify', v.body], ['login', login.body], ['refresh', refresh.body]]) {
    const s = JSON.stringify(body);
    for (const secret of ['Meera', 'Patel', 'female', 'firstName', 'signupBonus']) assert.equal(s.includes(secret), false, `${what}: ${secret}`);
  }
  const prof = await api().post('/api/v1/me/profile').set(bearer(v.body.accessToken)).send({ username: 'meera_p', avatarId: 4 });
  assert.equal(prof.status, 201, JSON.stringify(prof.body));
  assert.equal(JSON.stringify(prof.body).includes('Patel'), false);
  const check = await api().get('/api/v1/usernames/check').query({ username: 'meera_p' });
  assert.equal(JSON.stringify(check.body).includes('Meera'), false);

  const admin = await h.adminLogin(await h.makeAdmin('boss@example.org'));
  const list = await api().get('/api/v1/admin/users').set(bearer(admin.token)).query({ q: 'meera' });
  assert.equal(list.status, 200);
  assert.equal(JSON.stringify(list.body).includes('Patel'), false, 'never in the admin list');
  const detail = await api().get(`/api/v1/admin/users/${v.body.account.id}`).set(bearer(admin.token));
  assert.equal(detail.body.account.firstName, 'Meera');
  assert.equal(detail.body.account.lastName, 'Patel');
  assert.equal(detail.body.account.gender, 'female');
  const audit = await query('SELECT details FROM audit_log');
  assert.equal(JSON.stringify(audit).includes('Patel'), false, 'the audit log keeps no names');
});

test('names, gender, DOB and password are never logged', async () => {
  const lines = [];
  const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(a.map(String).join(' '));
  try {
    const dob = h.dobYearsAgo(25);
    await register(independent({ dob }));
    await register(independent({ email: 'x@example.org', firstName: 'B@d' }));
    await register(independent({ email: 'y@example.org', dob: h.dobYearsAgo(5) }));
    const v = await verify('meera@example.org');
    await api().get('/api/v1/me').set(bearer(v.body.accessToken));
    const all = lines.join('\n');
    for (const secret of ['Meera', 'Patel', 'female', dob, 'Secret123', 'B@d']) assert.equal(all.includes(secret), false, secret);
  } finally {
    Object.assign(console, orig);
  }
});

test('deleting the account deletes its sign-up details and bonus', async () => {
  await register(independent());
  const v = await verify('meera@example.org');
  const del = await api().delete('/api/v1/me').set(bearer(v.body.accessToken)).send({ password: 'Secret123', confirm: true });
  assert.equal(del.status, 200);
  assert.equal((await query('SELECT COUNT(*) AS n FROM signup_bonuses'))[0].n, 0);
  assert.equal((await query('SELECT COUNT(*) AS n FROM accounts'))[0].n, 0);
});

test('/api-docs.json documents the Sign Up fields and the reserved bonus', async () => {
  const r = await api().get('/api-docs.json');
  const reg = r.body.paths['/auth/register'].post.requestBody.content['application/json'].schema;
  for (const f of ['firstName', 'lastName', 'gender']) assert.ok(reg.properties[f], f);
  assert.ok(reg.required.includes('firstName') && reg.required.includes('gender'));
  assert.deepEqual(reg.properties.gender.enum, ['male', 'female', 'prefer_not_to_say']);
  const me = JSON.stringify(r.body.paths['/me'].get);
  assert.ok(me.includes('signupBonus') && me.includes('firstName'));
  assert.ok(JSON.stringify(r.body.paths['/admin/users/{accountId}'].get).includes('firstName'));
});
