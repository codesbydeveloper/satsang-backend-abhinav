const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { api, bearer } = h;

beforeEach(h.resetDb);
after(() => h.pool.end());

test('register → verify email → logged in with own profile active', async () => {
  const body = await h.adultLogin();
  assert.ok(body.accessToken && body.refreshToken);
  assert.equal(body.profiles.length, 1);
  assert.equal(body.profiles[0].username, 'ravi_k');
  assert.equal(body.profiles[0].ageGroup, 'Yuvak/Yuvatis A');
  assert.equal(body.activeProfileId, body.profiles[0].id);
  const me = await api().get('/api/v1/me').set(bearer(body.accessToken));
  assert.equal(me.status, 200);
  assert.equal(me.body.account.email, 'ravi@example.org');
});

test('cannot log in before verifying email; wrong password and unknown email look identical', async () => {
  await api().post('/api/v1/auth/register').send({ email: 'a@example.org', password: 'Secret123', accountType: 'adult', acceptPrivacyPolicy: true, profile: { username: 'aaa_b', avatarId: 1, dob: h.dobYearsAgo(25) } });
  const unverified = await api().post('/api/v1/auth/login').send({ email: 'a@example.org', password: 'Secret123' });
  assert.equal(unverified.status, 403); assert.equal(unverified.body.error.code, 'EMAIL_NOT_VERIFIED');
  const wrong = await api().post('/api/v1/auth/login').send({ email: 'a@example.org', password: 'Nope12345' });
  const unknown = await api().post('/api/v1/auth/login').send({ email: 'zz@example.org', password: 'Nope12345' });
  assert.equal(wrong.status, 401); assert.equal(unknown.status, 401);
  assert.equal(wrong.body.error.code, unknown.body.error.code);
});

test('wrong verification code is rejected and locks after 5 tries', async () => {
  await api().post('/api/v1/auth/register').send({ email: 'c@example.org', password: 'Secret123', accountType: 'adult', acceptPrivacyPolicy: true, profile: { username: 'cccc', avatarId: 1, dob: h.dobYearsAgo(25) } });
  const real = h.lastCode('c@example.org');
  const wrong = real === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) assert.equal((await api().post('/api/v1/auth/verify-email').send({ email: 'c@example.org', code: wrong })).status, 400);
  const locked = await api().post('/api/v1/auth/verify-email').send({ email: 'c@example.org', code: real });
  assert.equal(locked.status, 429);
});

test('registration rules: duplicate email, privacy policy, weak password, under-13 independent user', async () => {
  await h.adultLogin();
  const dup = await api().post('/api/v1/auth/register').send({ email: 'RAVI@example.org', password: 'Secret123', accountType: 'adult', acceptPrivacyPolicy: true, profile: { username: 'other_one', avatarId: 1, dob: h.dobYearsAgo(30) } });
  assert.equal(dup.status, 409); assert.equal(dup.body.error.code, 'EMAIL_TAKEN');
  const noPolicy = await api().post('/api/v1/auth/register').send({ email: 'n@example.org', password: 'Secret123', accountType: 'adult', profile: { username: 'nnnn', avatarId: 1, dob: h.dobYearsAgo(30) } });
  assert.equal(noPolicy.status, 400);
  const weak = await api().post('/api/v1/auth/register').send({ email: 'w@example.org', password: 'short', accountType: 'adult', acceptPrivacyPolicy: true, profile: { username: 'wwww', avatarId: 1, dob: h.dobYearsAgo(30) } });
  assert.equal(weak.status, 400); assert.equal(weak.body.error.code, 'VALIDATION_ERROR');
  const kid = await api().post('/api/v1/auth/register').send({ email: 'k@example.org', password: 'Secret123', accountType: 'adult', acceptPrivacyPolicy: true, profile: { username: 'kiddo', avatarId: 1, dob: h.dobYearsAgo(9) } });
  assert.equal(kid.status, 400); assert.equal(kid.body.error.code, 'PARENT_ACCOUNT_REQUIRED');
  const future = await api().post('/api/v1/auth/register').send({ email: 'f@example.org', password: 'Secret123', accountType: 'adult', acceptPrivacyPolicy: true, profile: { username: 'futur', avatarId: 1, dob: '2999-01-01' } });
  assert.equal(future.status, 400);
});

test('usernames: case-insensitive unique, blocked words incl. look-alikes, reserved, Gujarati allowed', async () => {
  await h.adultLogin('r1@example.org', 'Ravi_K');
  const check = async (u) => (await api().get('/api/v1/usernames/check').query({ username: u })).body;
  assert.deepEqual(await check('rAVI_k'), { available: false, reason: 'TAKEN' });
  assert.equal((await check('sh1t_lord')).reason, 'BLOCKED_WORD');
  assert.equal((await check('Admin')).reason, 'RESERVED');
  assert.equal((await check('ab')).reason, 'INVALID_FORMAT');
  assert.equal((await check('bad name!')).reason, 'INVALID_FORMAT');
  assert.equal((await check('રવિકુમાર')).available, true);
  // reserved names only block exact matches
  assert.equal((await check('adminfan123')).available, true);
});

test('refresh tokens rotate: old one stops working', async () => {
  const s = await h.adultLogin();
  const r1 = await api().post('/api/v1/auth/refresh').send({ refreshToken: s.refreshToken });
  assert.equal(r1.status, 200);
  assert.notEqual(r1.body.refreshToken, s.refreshToken);
  assert.equal((await api().post('/api/v1/auth/refresh').send({ refreshToken: s.refreshToken })).status, 401);
  assert.equal((await api().get('/api/v1/me').set(bearer(r1.body.accessToken))).status, 200);
  assert.equal(r1.body.activeProfileId, s.activeProfileId);
});

test('logout ends the session immediately', async () => {
  const s = await h.adultLogin();
  assert.equal((await api().post('/api/v1/auth/logout').set(bearer(s.accessToken))).status, 200);
  const me = await api().get('/api/v1/me').set(bearer(s.accessToken));
  assert.equal(me.status, 401); assert.equal(me.body.error.code, 'SESSION_ENDED');
  assert.equal((await api().post('/api/v1/auth/refresh').send({ refreshToken: s.refreshToken })).status, 401);
});

test('password reset: code flow, then every old session is invalid and new password works', async () => {
  const s = await h.adultLogin();
  assert.equal((await api().post('/api/v1/auth/forgot-password').send({ email: 'nobody@example.org' })).status, 200);
  assert.equal(h.lastCode('nobody@example.org'), undefined);
  await api().post('/api/v1/auth/forgot-password').send({ email: 'ravi@example.org' });
  const code = h.lastCode('ravi@example.org');
  const bad = await api().post('/api/v1/auth/reset-password').send({ email: 'ravi@example.org', code: code === '123456' ? '654321' : '123456', newPassword: 'NewSecret456' });
  assert.equal(bad.status, 400);
  assert.equal((await api().post('/api/v1/auth/reset-password').send({ email: 'ravi@example.org', code, newPassword: 'NewSecret456' })).status, 200);
  assert.equal((await api().get('/api/v1/me').set(bearer(s.accessToken))).status, 401);
  assert.equal((await api().post('/api/v1/auth/refresh').send({ refreshToken: s.refreshToken })).status, 401);
  assert.equal((await api().post('/api/v1/auth/login').send({ email: 'ravi@example.org', password: 'Secret123' })).status, 401);
  assert.equal((await api().post('/api/v1/auth/login').send({ email: 'ravi@example.org', password: 'NewSecret456' })).status, 200);
  // the code is single-use
  assert.equal((await api().post('/api/v1/auth/reset-password').send({ email: 'ravi@example.org', code, newPassword: 'Another789' })).status, 400);
});

test('change password logs out other devices but keeps this one', async () => {
  const a = await h.adultLogin();
  const other = await api().post('/api/v1/auth/login').send({ email: 'ravi@example.org', password: 'Secret123' });
  const c = await api().post('/api/v1/me/change-password').set(bearer(a.accessToken)).send({ currentPassword: 'Secret123', newPassword: 'Changed4567' });
  assert.equal(c.status, 200);
  assert.equal((await api().get('/api/v1/me').set(bearer(other.body.accessToken))).status, 401);
  assert.equal((await api().get('/api/v1/me').set(bearer(c.body.accessToken))).status, 200);
  assert.equal((await api().post('/api/v1/me/change-password').set(bearer(c.body.accessToken)).send({ currentPassword: 'wrong', newPassword: 'Changed9999' })).status, 401);
});

test('adult deletes own account with password; everything is gone and the email can be reused', async () => {
  const s = await h.adultLogin();
  assert.equal((await api().delete('/api/v1/me').set(bearer(s.accessToken)).send({ password: 'bad', confirm: true })).status, 401);
  assert.equal((await api().delete('/api/v1/me').set(bearer(s.accessToken)).send({ password: 'Secret123', confirm: true })).status, 200);
  assert.equal((await h.query('SELECT COUNT(*) n FROM profiles'))[0].n, 0);
  assert.equal((await h.query('SELECT COUNT(*) n FROM refresh_tokens'))[0].n, 0);
  assert.equal((await api().get('/api/v1/me').set(bearer(s.accessToken))).status, 401);
  await h.adultLogin(); // same email + username register again
});

test('public delete-account page endpoint works with email + password only', async () => {
  await h.adultLogin();
  assert.equal((await api().post('/api/v1/public/delete-account').send({ email: 'ravi@example.org', password: 'bad', confirm: true })).status, 401);
  assert.equal((await api().post('/api/v1/public/delete-account').send({ email: 'ravi@example.org', password: 'Secret123', confirm: true })).status, 200);
  assert.equal((await h.query('SELECT COUNT(*) n FROM accounts'))[0].n, 0);
});
