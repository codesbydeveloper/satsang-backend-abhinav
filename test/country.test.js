// Profile setup "Country / region": profiles.country (ISO 3166-1 alpha-2), private to the profile's own account.
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { api, bearer } = h;
const { COUNTRY_CODES, isCountryCode } = require('../src/utils/countries');

beforeEach(h.resetDb);
after(() => h.pool.end());

/** Register with dob only + verify (no profile yet), like the app's independent Sign Up. */
async function independentLogin(email = 'meera@example.org') {
  const reg = await api().post('/api/v1/auth/register')
    .send({ ...h.NAMES, email, password: 'Secret123', accountType: 'adult', acceptPrivacyPolicy: true, dob: h.dobYearsAgo(25) });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  return (await api().post('/api/v1/auth/verify-email').send({ email, code: h.lastCode(email) })).body;
}

const addChild = (p, extra = {}) => api().post('/api/v1/profiles').set(p.auth)
  .send({ username: 'kid_aaa', avatarId: 2, dob: h.dobYearsAgo(8, 30), parentalConsent: true, ...extra });
const asChild = async (p, id) => bearer((await api().post('/api/v1/me/active-profile').set(p.auth).send({ profileId: id })).body.accessToken);
const fieldError = (r) => r.body.error && r.body.error.details && r.body.error.details.map((d) => d.field);

test('the ISO 3166-1 alpha-2 list: 249 assigned codes, upper case, unique', () => {
  assert.equal(COUNTRY_CODES.length, 249);
  assert.equal(new Set(COUNTRY_CODES).size, 249);
  assert.ok(COUNTRY_CODES.every((c) => /^[A-Z]{2}$/.test(c)));
  for (const c of ['IN', 'US', 'GB', 'CA', 'AU', 'NZ', 'KE', 'AE']) assert.ok(isCountryCode(c), c);
  for (const c of ['XK', 'UK', 'EU', 'XX', 'in', 'IND', '', null, 91]) assert.equal(isCountryCode(c), false, String(c));
});

test('POST /me/profile stores the country (upper case) and GET /me returns it to the owner', async () => {
  const s = await independentLogin();
  const r = await api().post('/api/v1/me/profile').set(bearer(s.accessToken)).send({ username: 'Meera_P', avatarId: 7, mode: 'satsang', country: ' in ' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.profile.country, 'IN');
  assert.equal((await h.query('SELECT country FROM profiles WHERE id = ?', [r.body.profile.id]))[0].country, 'IN');
  const me = await api().get('/api/v1/me').set(bearer(r.body.accessToken));
  assert.equal(me.body.profiles[0].country, 'IN');
});

test('a country outside the ISO list is refused on every endpoint (400 VALIDATION_ERROR on country)', async () => {
  const s = await independentLogin();
  for (const country of ['XX', 'UK', 'IND', 'X', 'XK', '']) {
    const r = await api().post('/api/v1/me/profile').set(bearer(s.accessToken)).send({ username: 'Meera_P', avatarId: 7, country });
    assert.equal(r.status, 400, country);
    assert.deepEqual(fieldError(r), ['country'], country);
  }
  assert.equal((await h.query('SELECT COUNT(*) n FROM profiles'))[0].n, 0, 'nothing stored');
  const made = await api().post('/api/v1/me/profile').set(bearer(s.accessToken)).send({ username: 'Meera_P', avatarId: 7 });
  assert.equal(made.status, 201);
  assert.equal(made.body.profile.country, null, 'optional: older app builds send none');
  const auth = bearer(made.body.accessToken);
  assert.deepEqual(fieldError(await api().patch('/api/v1/me/settings').set(auth).send({ country: 'ZZ' })), ['country']);
  assert.deepEqual(fieldError(await api().patch(`/api/v1/profiles/${made.body.profile.id}`).set(auth).send({ country: 'ZZ' })), ['country']);
  assert.equal((await api().patch('/api/v1/me/settings').set(auth).send({ country: null })).status, 400, 'cannot be cleared');
});

test('PATCH /me/settings: an independent account changes its country; the parent area has none; a child is refused', async () => {
  const s = await independentLogin();
  const made = await api().post('/api/v1/me/profile').set(bearer(s.accessToken)).send({ username: 'Meera_P', avatarId: 7, country: 'IN' });
  const r = await api().patch('/api/v1/me/settings').set(bearer(made.body.accessToken)).send({ country: 'gb' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.profile.country, 'GB');

  const p = await h.parentLogin();
  const kid = (await addChild(p, { country: 'US' })).body.profile;
  assert.equal((await api().patch('/api/v1/me/settings').set(p.auth).send({ country: 'CA' })).body.error.code, 'NO_ACTIVE_PROFILE');
  const refused = await api().patch('/api/v1/me/settings').set(await asChild(p, kid.id)).send({ country: 'CA' });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, 'PARENT_MODE_REQUIRED');
  assert.equal((await h.query('SELECT country FROM profiles WHERE id = ?', [kid.id]))[0].country, 'US', 'unchanged');
});

test('child profiles: country set in POST /profiles; changed by the parent (parent area, or the PIN from the child)', async () => {
  const p = await h.parentLogin();
  const created = await addChild(p, { country: 'us' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const kid = created.body.profile;
  assert.equal(kid.country, 'US');
  assert.equal((await api().post('/api/v1/profiles').set(p.auth).send({ username: 'kid_bbb', avatarId: 2, dob: h.dobYearsAgo(8), parentalConsent: true, pin: '1234' })).body.profile.country, null);

  const area = await api().patch(`/api/v1/profiles/${kid.id}`).set(p.auth).send({ country: 'AU' });
  assert.equal(area.status, 200);
  assert.equal(area.body.profile.country, 'AU');

  const child = await asChild(p, kid.id);
  const noPin = await api().patch(`/api/v1/profiles/${kid.id}`).set(child).send({ country: 'NZ' });
  assert.equal(noPin.status, 403);
  assert.equal(noPin.body.error.code, 'PIN_REQUIRED');
  const withPin = await api().patch(`/api/v1/profiles/${kid.id}`).set(child).send({ country: 'NZ', pin: '1234' });
  assert.equal(withPin.status, 200);
  assert.equal(withPin.body.profile.country, 'NZ');
});

test('the country is private: not in the username check or the Admin Panel user list / detail', async () => {
  const u = await h.adultLogin('ravi@example.org', 'ravi_k');
  await api().patch('/api/v1/me/settings').set(bearer(u.accessToken)).send({ country: 'KE' });
  const check = await api().get('/api/v1/usernames/check').query({ username: 'ravi_k' });
  assert.equal(/country|"KE"/.test(JSON.stringify(check.body)), false);
  const boss = await h.makeAdmin('boss@example.org'); const b = await h.adminLogin(boss);
  const list = await api().get('/api/v1/admin/users').set(bearer(b.token)).query({ q: 'ravi' });
  const detail = await api().get(`/api/v1/admin/users/${u.account.id}`).set(bearer(b.token));
  for (const body of [list.body, detail.body]) {
    assert.equal(JSON.stringify(body).includes('country'), false);
    assert.equal(JSON.stringify(body).includes('"KE"'), false);
  }
});

test('/api-docs.json documents the country on the profile and on every endpoint that sets it', async () => {
  const r = await api().get('/api-docs.json');
  const s = r.body.components.schemas;
  assert.equal(s.CountryCode.pattern, '^[A-Z]{2}$');
  assert.ok(JSON.stringify(s.Profile.properties.country).includes('CountryCode'));
  const bodyOf = (path, verb) => JSON.stringify(r.body.paths[path][verb].requestBody);
  for (const [path, verb] of [['/me/profile', 'post'], ['/profiles', 'post'], ['/me/settings', 'patch'], ['/profiles/{id}', 'patch']]) {
    assert.ok(bodyOf(path, verb).includes('CountryCode'), `${verb} ${path}`);
  }
});
