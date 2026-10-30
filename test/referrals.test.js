// Referrals (contract 8.3 + client rules, 30 Oct 2026): GET /me/referral, POST /me/referral/apply, admin settings + list.
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { api, bearer } = h;
const R = require('../src/utils/referrals');

beforeEach(h.resetDb);
after(() => h.pool.end());

const me = (auth) => api().get('/api/v1/me/referral').set(auth);
const apply = (auth, code, extra = {}) => api().post('/api/v1/me/referral/apply').set(auth).send({ code, ...extra });

async function adult(email, username) {
  const s = await h.adultLogin(email, username);
  return { auth: bearer(s.accessToken), accountId: s.account.id };
}

test('every account gets a unique 6-character code without 0 / O / 1 / I', async () => {
  for (let i = 0; i < 500; i++) assert.match(R.newCode(), /^[2-9A-HJ-NP-Z]{6}$/);
  assert.ok(!/[01OI]/.test(R.ALPHABET));
  const a = await adult('a@example.org', 'asha_a');
  const b = await adult('b@example.org', 'bina_b');
  const ra = await me(a.auth);
  assert.equal(ra.status, 200);
  assert.match(ra.body.code, /^[2-9A-HJ-NP-Z]{6}$/);
  assert.notEqual(ra.body.code, (await me(b.auth)).body.code);
  assert.equal((await me(a.auth)).body.code, ra.body.code, 'stable');
  assert.deepEqual(ra.body.counts, { total: 0, waitingForFirstQuiz: 0, qualified: 0, sparksPending: 0 });
  assert.equal(ra.body.canApply, true);
  assert.equal(ra.body.applied, null);
  assert.equal(ra.body.windowHours, 48);
});

test('apply: new user +25 reserved at once; referrer +50 waits for the first full quiz', async () => {
  const friend = await adult('friend@example.org', 'friend_1');
  const code = (await me(friend.auth)).body.code;
  const newbie = await adult('new@example.org', 'new_one');
  const r = await apply(newbie.auth, ` ${code.toLowerCase()} `);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.applied.sparks, 25);
  assert.equal(r.body.applied.status, 'reserved');
  assert.deepEqual(r.body.referral.applied, { code, sparks: 25, status: 'reserved' });
  assert.equal(r.body.referral.canApply, false);

  const row = (await h.query('SELECT * FROM referrals'))[0];
  assert.equal(row.status, 'waiting_for_first_quiz');
  assert.equal(row.referrer_sparks, 50);
  const f = (await me(friend.auth)).body.counts;
  assert.deepEqual(f, { total: 1, waitingForFirstQuiz: 1, qualified: 0, sparksPending: 0 });

  // Milestone 3 hook: the new user's first full quiz
  const profileId = (await h.query('SELECT id FROM profiles WHERE account_id = ?', [newbie.accountId]))[0].id;
  assert.equal(await R.onFirstQuizCompleted(profileId), true);
  assert.equal(await R.onFirstQuizCompleted(profileId), false, 'only once');
  assert.deepEqual((await me(friend.auth)).body.counts, { total: 1, waitingForFirstQuiz: 0, qualified: 1, sparksPending: 50 });
});

test('errors: INVALID_CODE, SELF_REFERRAL (own code, same mailbox), ALREADY_APPLIED, WINDOW_EXPIRED', async () => {
  const a = await adult('ravi.kumar@gmail.com', 'ravi_k');
  const code = (await me(a.auth)).body.code;

  for (const bad of ['NOPE00', 'ABC', 'ZZZZZZ']) {
    const r = await apply(a.auth, bad);
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'INVALID_CODE');
  }
  const own = await apply(a.auth, code);
  assert.equal(own.status, 400);
  assert.equal(own.body.error.code, 'SELF_REFERRAL');

  const alias = await adult('ravikumar+second@gmail.com', 'ravi_two');
  const same = await apply(alias.auth, code);
  assert.equal(same.status, 400);
  assert.equal(same.body.error.code, 'SELF_REFERRAL', 'the same Gmail mailbox');

  const b = await adult('b@example.org', 'bina_b');
  assert.equal((await apply(b.auth, code)).status, 200);
  const again = await apply(b.auth, code);
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'ALREADY_APPLIED');

  const late = await adult('late@example.org', 'late_one');
  await h.query('UPDATE accounts SET created_at = NOW() - INTERVAL 49 HOUR WHERE id = ?', [late.accountId]);
  const expired = await apply(late.auth, code);
  assert.equal(expired.status, 403);
  assert.equal(expired.body.error.code, 'WINDOW_EXPIRED');
  assert.equal((await me(late.auth)).body.canApply, false);
});

test('one referral per device (the app\'s install id, stored only as an HMAC)', async () => {
  const friend = await adult('friend@example.org', 'friend_1');
  const code = (await me(friend.auth)).body.code;
  const one = await adult('one@example.org', 'one_one');
  const two = await adult('two@example.org', 'two_two');
  const deviceId = 'install-1234567890';
  assert.equal((await apply(one.auth, code, { deviceId })).status, 200);
  const r = await apply(two.auth, code, { deviceId });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'ALREADY_APPLIED');
  const stored = (await h.query('SELECT device_hash FROM referrals'))[0].device_hash;
  assert.match(stored, /^[0-9a-f]{64}$/);
  assert.ok(!stored.includes(deviceId));
});

test('REFERRER_LIMIT and the window follow the admin settings', async () => {
  const friend = await adult('friend@example.org', 'friend_1');
  const code = (await me(friend.auth)).body.code;
  await h.query("UPDATE app_settings SET value = '1' WHERE setting_key = 'referral_max_per_referrer'");
  await h.query("UPDATE app_settings SET value = '30' WHERE setting_key = 'referral_new_user_sparks'");
  const one = await adult('one@example.org', 'one_one');
  assert.equal((await apply(one.auth, code)).body.applied.sparks, 30);
  const two = await adult('two@example.org', 'two_two');
  const r = await apply(two.auth, code);
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'REFERRER_LIMIT');

  await h.query("UPDATE app_settings SET value = '1' WHERE setting_key = 'referral_window_hours'");
  await h.query('UPDATE accounts SET created_at = NOW() - INTERVAL 2 HOUR WHERE id = ?', [two.accountId]);
  assert.equal((await apply(two.auth, code)).body.error.code, 'WINDOW_EXPIRED');
});

test('parent accounts: the code is the account\'s; applying needs the parent area', async () => {
  const friend = await adult('friend@example.org', 'friend_1');
  const code = (await me(friend.auth)).body.code;
  const p = await h.parentLogin();
  const kid = (await api().post('/api/v1/profiles').set(p.auth)
    .send({ username: 'kid_aaa', avatarId: 2, dob: h.dobYearsAgo(8), parentalConsent: true, pin: '1234' })).body.profile;
  const asKid = bearer((await api().post('/api/v1/me/active-profile').set(p.auth).send({ profileId: kid.id })).body.accessToken);
  assert.equal((await me(asKid)).body.code, (await me(p.auth)).body.code, 'one code per account');
  const fromChild = await apply(asKid, code);
  assert.equal(fromChild.status, 403);
  assert.equal(fromChild.body.error.code, 'PARENT_MODE_REQUIRED');
  const back = await api().post("/api/v1/me/active-profile").set(asKid).send({ profileId: null, pin: "1234" });
  const fromParent = await apply(bearer(back.body.accessToken), code);
  assert.equal(fromParent.status, 200, JSON.stringify(fromParent.body));
});

test('deleting accounts: the new user\'s row goes; the referrer\'s deletion keeps the new user\'s reward', async () => {
  const friend = await adult('friend@example.org', 'friend_1');
  const code = (await me(friend.auth)).body.code;
  const newbie = await adult('new@example.org', 'new_one');
  await apply(newbie.auth, code);
  assert.equal((await api().delete('/api/v1/me').set(friend.auth).send({ password: 'Secret123', confirm: true })).status, 200);
  const row = (await h.query('SELECT referrer_account_id, new_user_sparks FROM referrals'))[0];
  assert.equal(row.referrer_account_id, null);
  assert.equal(row.new_user_sparks, 25);
  assert.equal((await api().delete('/api/v1/me').set(newbie.auth).send({ password: 'Secret123', confirm: true })).status, 200);
  assert.equal(Number((await h.query('SELECT COUNT(*) AS n FROM referrals'))[0].n), 0);
});

test('admin: Full Admin reads and changes the settings (audited); the list shows usernames, not emails', async () => {
  const full = await h.adminLogin(await h.makeAdmin('boss@example.org'));
  const editor = await h.adminLogin(await h.makeAdmin('ed@example.org', 'content_editor'));
  const A = bearer(full.token);

  const s = await api().get('/api/v1/admin/referrals/settings').set(A);
  assert.equal(s.status, 200);
  assert.deepEqual(s.body.settings, { newUserSparks: 25, referrerSparks: 50, windowHours: 48, maxPerReferrer: null });

  const put = await api().put('/api/v1/admin/referrals/settings').set(A).send({ referrerSparks: 60, maxPerReferrer: 10 });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.deepEqual(put.body.settings, { newUserSparks: 25, referrerSparks: 60, windowHours: 48, maxPerReferrer: 10 });
  const log = (await h.query("SELECT details FROM audit_log WHERE action = 'referral_settings.updated'"))[0];
  assert.deepEqual(typeof log.details === 'string' ? JSON.parse(log.details) : log.details, { referrerSparks: { from: 50, to: 60 }, maxPerReferrer: { from: null, to: 10 } });
  assert.equal((await api().put('/api/v1/admin/referrals/settings').set(A).send({ maxPerReferrer: null })).body.settings.maxPerReferrer, null, 'back to unlimited');
  assert.equal((await api().put('/api/v1/admin/referrals/settings').set(A).send({ windowHours: 0 })).status, 400);
  assert.equal((await api().put('/api/v1/admin/referrals/settings').set(A).send({})).status, 400);

  const friend = await adult('friend@example.org', 'friend_1');
  const code = (await me(friend.auth)).body.code;
  const newbie = await adult('new@example.org', 'new_one');
  await apply(newbie.auth, code);
  const list = await api().get('/api/v1/admin/referrals').set(A);
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 1);
  const row = list.body.rows[0];
  assert.equal(row.code, code);
  assert.equal(row.referrer.username, 'friend_1');
  assert.equal(row.referee.username, 'new_one');
  assert.equal(row.status, 'waiting_for_first_quiz');
  assert.equal(row.referrerSparks, 60, 'the amount at the time the code was applied');
  assert.ok(!JSON.stringify(list.body).includes('@example.org'), 'no emails');
  assert.equal((await api().get('/api/v1/admin/referrals?q=new_').set(A)).body.total, 1);
  assert.equal((await api().get('/api/v1/admin/referrals?status=qualified').set(A)).body.total, 0);

  // Content Editor: neither the list nor the settings
  for (const path of ['/api/v1/admin/referrals', '/api/v1/admin/referrals/settings']) {
    const r = await api().get(path).set(bearer(editor.token));
    assert.equal(r.status, 403, path);
  }
  assert.equal((await api().put('/api/v1/admin/referrals/settings').set(bearer(editor.token)).send({ windowHours: 24 })).status, 403);
});

test('/api-docs lists the referral endpoints', async () => {
  const r = await api().get('/api-docs.json');
  for (const p of ['/me/referral', '/me/referral/apply', '/admin/referrals', '/admin/referrals/settings']) assert.ok(r.body.paths[p], p);
});
