// Independent accounts: date of birth first (neutral age gate), profile later with POST /me/profile.
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const config = require('../src/config');
const { api, bearer } = h;

beforeEach(h.resetDb);
after(() => h.pool.end());

const register = (email, dob, extra = {}) => api().post('/api/v1/auth/register')
  .send({ email, password: 'Secret123', accountType: 'adult', acceptPrivacyPolicy: true, dob, ...extra });

/** Register with dob only + verify; returns the AuthResponse (no profile yet). */
async function independentLogin(email = 'meera@example.org', years = 25) {
  const reg = await register(email, h.dobYearsAgo(years));
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const v = await api().post('/api/v1/auth/verify-email').send({ email, code: h.lastCode(email) });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  return v.body;
}

test('independent register needs only the date of birth; the session starts without a profile', async () => {
  const body = await independentLogin();
  assert.deepEqual(body.profiles, []);
  assert.equal(body.activeProfileId, null);
  assert.equal(body.account.accountType, 'adult');
  assert.equal(JSON.stringify(body).includes('dob'), false, 'the DOB is never returned');
  const me = await api().get('/api/v1/me').set(bearer(body.accessToken));
  assert.equal(me.status, 200);
  assert.equal(JSON.stringify(me.body).includes('dob'), false);
});

test('under the consent age: PARENT_ACCOUNT_REQUIRED, nothing stored, no email, cut-off age not revealed', async () => {
  const kid = await register('kid@example.org', h.dobYearsAgo(config.parentalConsentAge, -1));   // reaches the consent age tomorrow
  assert.equal(kid.status, 400);
  assert.equal(kid.body.error.code, 'PARENT_ACCOUNT_REQUIRED');
  assert.equal(/\d/.test(kid.body.error.message), false, 'no age in the message');
  assert.equal((await h.query('SELECT COUNT(*) AS n FROM accounts'))[0].n, 0);
  assert.equal(h.outbox.length, 0, 'no verification email');
});

test('the age gate comes before the email check (an existing email is not revealed to a child)', async () => {
  await independentLogin('taken@example.org');
  const kid = await register('taken@example.org', h.dobYearsAgo(9));
  assert.equal(kid.status, 400);
  assert.equal(kid.body.error.code, 'PARENT_ACCOUNT_REQUIRED');
});

test('exactly the consent age may hold an independent account', async () => {
  const teen = await register('teen@example.org', h.dobYearsAgo(config.parentalConsentAge));
  assert.equal(teen.status, 201);
});

test('dob rules: required for independent, not accepted for parents, not both dob and profile', async () => {
  const none = await api().post('/api/v1/auth/register').send({ email: 'x@example.org', password: 'Secret123', accountType: 'adult', acceptPrivacyPolicy: true });
  assert.equal(none.status, 400); assert.equal(none.body.error.code, 'VALIDATION_ERROR');
  assert.equal(none.body.error.details[0].field, 'dob');

  const parent = await api().post('/api/v1/auth/register').send({ email: 'p@example.org', password: 'Secret123', accountType: 'parent', acceptPrivacyPolicy: true, confirmAdult: true, dob: h.dobYearsAgo(40) });
  assert.equal(parent.status, 400); assert.equal(parent.body.error.code, 'VALIDATION_ERROR');

  const both = await register('b@example.org', h.dobYearsAgo(30), { profile: { username: 'both_ways', avatarId: 1, dob: h.dobYearsAgo(30) } });
  assert.equal(both.status, 400);

  const future = await register('f@example.org', '2999-01-01');
  assert.equal(future.status, 400); assert.equal(future.body.error.code, 'VALIDATION_ERROR');
});

test('POST /me/profile creates the profile from the stored dob, activates it and clears the dob from the account', async () => {
  const s = await independentLogin('meera@example.org', 25);
  const r = await api().post('/api/v1/me/profile').set(bearer(s.accessToken)).send({ username: 'Meera_P', avatarId: 7, mode: 'sanatan' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(r.body.accessToken);
  assert.equal(r.body.activeProfileId, r.body.profile.id);
  assert.equal(r.body.profile.username, 'Meera_P');
  assert.equal(r.body.profile.avatarId, 7);
  assert.equal(r.body.profile.mode, 'sanatan');
  assert.equal(r.body.profile.isChild, false);
  assert.equal(r.body.profile.ageGroup, 'Yuvak/Yuvatis A');
  assert.equal(r.body.profile.dob, h.dobYearsAgo(25), 'own view includes the dob, taken from registration');

  assert.equal((await h.query('SELECT dob FROM accounts WHERE email = ?', ['meera@example.org']))[0].dob, null, 'dob lives on the profile only');

  // The new token plays as the profile; refreshing keeps it active.
  const me = await api().get('/api/v1/me').set(bearer(r.body.accessToken));
  assert.equal(me.body.activeProfileId, r.body.profile.id);
  const refreshed = await api().post('/api/v1/auth/refresh').send({ refreshToken: s.refreshToken });
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.activeProfileId, r.body.profile.id);

  // A later login also starts in the profile.
  const login = await api().post('/api/v1/auth/login').send({ email: 'meera@example.org', password: 'Secret123' });
  assert.equal(login.body.activeProfileId, r.body.profile.id);
});

test('POST /me/profile: only once, only independent accounts, username rules apply', async () => {
  const s = await independentLogin();
  const auth = bearer(s.accessToken);
  const badName = await api().post('/api/v1/me/profile').set(auth).send({ username: 'no spaces!', avatarId: 1 });
  assert.equal(badName.status, 400);
  const ok = await api().post('/api/v1/me/profile').set(auth).send({ username: 'first_one', avatarId: 1 });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.profile.mode, null);
  const again = await api().post('/api/v1/me/profile').set(bearer(ok.body.accessToken)).send({ username: 'second_one', avatarId: 2 });
  assert.equal(again.status, 409); assert.equal(again.body.error.code, 'PROFILE_EXISTS');

  const taken = await independentLogin('other@example.org');
  const dup = await api().post('/api/v1/me/profile').set(bearer(taken.accessToken)).send({ username: 'FIRST_ONE', avatarId: 1 });
  assert.equal(dup.status, 400); assert.equal(dup.body.error.code, 'USERNAME_TAKEN');

  const parent = await h.parentLogin();
  const p = await api().post('/api/v1/me/profile').set(parent.auth).send({ username: 'parent_me', avatarId: 1 });
  assert.equal(p.status, 403); assert.equal(p.body.error.code, 'INDEPENDENT_ONLY');

  const legacy = await h.adultLogin('legacy@example.org', 'legacy_one');   // registered with the one-step profile
  const l = await api().post('/api/v1/me/profile').set(bearer(legacy.accessToken)).send({ username: 'legacy_two', avatarId: 1 });
  assert.equal(l.status, 409);

  const anon = await api().post('/api/v1/me/profile').send({ username: 'nobody', avatarId: 1 });
  assert.equal(anon.status, 401);
});

test('/api-docs.json documents the dob field and POST /me/profile', async () => {
  const r = await api().get('/api-docs.json');
  assert.equal(r.status, 200);
  assert.ok(r.body.paths['/auth/register'].post.requestBody.content['application/json'].schema.properties.dob);
  assert.ok(r.body.paths['/me/profile'].post);
});
