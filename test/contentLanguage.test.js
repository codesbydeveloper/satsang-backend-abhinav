// Two languages (client, 3 Nov 2026): the app language (accounts.preferred_language / profiles.language) and the
// content language (profiles.content_language: questions, games, PDFs, learning content), per playable profile.
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { api, bearer } = h;

beforeEach(h.resetDb);
after(() => h.pool.end());

/** Register with dob only + verify (no profile yet), like the app's independent Sign Up. */
async function independentLogin(email = 'meera@example.org', language = 'en') {
  const reg = await api().post('/api/v1/auth/register')
    .send({ ...h.NAMES, email, password: 'Secret123', accountType: 'adult', acceptPrivacyPolicy: true, dob: h.dobYearsAgo(25), language });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  return (await api().post('/api/v1/auth/verify-email').send({ email, code: h.lastCode(email) })).body;
}

const addChild = (p, extra = {}) => api().post('/api/v1/profiles').set(p.auth)
  .send({ username: 'kid_aaa', avatarId: 2, dob: h.dobYearsAgo(8, 30), parentalConsent: true, ...extra });
const asChild = async (p, id) => bearer((await api().post('/api/v1/me/active-profile').set(p.auth).send({ profileId: id })).body.accessToken);
const fieldError = (r) => r.body.error && r.body.error.details && r.body.error.details.map((d) => d.field);

test('POST /me/profile: contentLanguage is stored apart from the app language and returned by GET /me', async () => {
  const s = await independentLogin('meera@example.org', 'en');
  const r = await api().post('/api/v1/me/profile').set(bearer(s.accessToken)).send({ username: 'Meera_P', avatarId: 7, mode: 'satsang', contentLanguage: 'gu' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.profile.language, 'en', 'the app language is unchanged');
  assert.equal(r.body.profile.contentLanguage, 'gu');
  const me = await api().get('/api/v1/me').set(bearer(r.body.accessToken));
  assert.equal(me.body.account.language, 'en');
  assert.equal(me.body.profiles[0].language, 'en');
  assert.equal(me.body.profiles[0].contentLanguage, 'gu');
});

test('without contentLanguage a new profile uses the app language', async () => {
  const s = await independentLogin('kiran@example.org', 'gu');
  const r = await api().post('/api/v1/me/profile').set(bearer(s.accessToken)).send({ username: 'Kiran_P', avatarId: 12 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.profile.contentLanguage, 'gu');
  const legacy = await h.adultLogin('ravi@example.org', 'ravi_k');   // the older one-step register with a profile
  const me = await api().get('/api/v1/me').set(bearer(legacy.accessToken));
  assert.equal(me.body.profiles[0].contentLanguage, 'en');
});

test('PATCH /me/settings changes the content language only; language still changes the app language', async () => {
  const s = await independentLogin();
  const made = await api().post('/api/v1/me/profile').set(bearer(s.accessToken)).send({ username: 'Meera_P', avatarId: 7 });
  const auth = bearer(made.body.accessToken);
  const c = await api().patch('/api/v1/me/settings').set(auth).send({ contentLanguage: 'gu' });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.profile.contentLanguage, 'gu');
  assert.equal(c.body.profile.language, 'en');
  assert.equal(c.body.account.language, 'en', 'the menus stay in English');
  const l = await api().patch('/api/v1/me/settings').set(auth).send({ language: 'gu' });
  assert.equal(l.body.account.language, 'gu');
  assert.equal(l.body.profile.contentLanguage, 'gu');
  const back = await api().patch('/api/v1/me/settings').set(auth).send({ contentLanguage: 'en' });
  assert.equal(back.body.profile.contentLanguage, 'en');
  assert.equal(back.body.profile.language, 'gu', 'the app language is not touched');
});

test('contentLanguage outside en / gu is refused (400 VALIDATION_ERROR on contentLanguage)', async () => {
  const s = await independentLogin();
  for (const contentLanguage of ['hi', 'EN', '', 3]) {
    const r = await api().post('/api/v1/me/profile').set(bearer(s.accessToken)).send({ username: 'Meera_P', avatarId: 7, contentLanguage });
    assert.equal(r.status, 400, String(contentLanguage));
    assert.deepEqual(fieldError(r), ['contentLanguage']);
  }
});

test('parent area: no active profile, so the content language cannot be set in /me/settings (400 NO_ACTIVE_PROFILE)', async () => {
  const p = await h.parentLogin();
  const r = await api().patch('/api/v1/me/settings').set(p.auth).send({ contentLanguage: 'gu' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'NO_ACTIVE_PROFILE');
});

test("child: the parent sets the content language on create and in Edit child; the child's session needs the PIN", async () => {
  const p = await h.parentLogin();
  const made = await addChild(p, { language: 'en', contentLanguage: 'gu' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.profile.language, 'en');
  assert.equal(made.body.profile.contentLanguage, 'gu');
  const id = made.body.profile.id;

  const plain = await api().post('/api/v1/profiles').set(p.auth)
    .send({ pin: '1234', username: 'kid_bbb', avatarId: 3, dob: h.dobYearsAgo(10), parentalConsent: true, language: 'gu' });
  assert.equal(plain.body.profile.contentLanguage, 'gu', 'defaults to the child\'s app language');

  const edit = await api().patch(`/api/v1/profiles/${id}`).set(p.auth).send({ contentLanguage: 'en' });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  assert.equal(edit.body.profile.contentLanguage, 'en');

  const child = await asChild(p, id);
  const no = await api().patch(`/api/v1/profiles/${id}`).set(child).send({ contentLanguage: 'gu' });
  assert.equal(no.status, 403);
  assert.equal(no.body.error.code, 'PIN_REQUIRED');
  const settings = await api().patch('/api/v1/me/settings').set(child).send({ contentLanguage: 'gu' });
  assert.equal(settings.status, 403);
  assert.equal(settings.body.error.code, 'PARENT_MODE_REQUIRED');
  const withPin = await api().patch(`/api/v1/profiles/${id}`).set(child).send({ contentLanguage: 'gu', pin: '1234' });
  assert.equal(withPin.status, 200);
  assert.equal(withPin.body.profile.contentLanguage, 'gu');

  const me = await api().get('/api/v1/me').set(p.auth);
  assert.deepEqual(me.body.profiles.map((x) => x.contentLanguage).sort(), ['gu', 'gu']);
});
