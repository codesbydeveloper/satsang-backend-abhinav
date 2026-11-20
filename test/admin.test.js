const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { api, bearer } = h;

beforeEach(h.resetDb);
after(() => h.pool.end());

const login = (a, password = a.password) => api().post('/api/v1/admin/auth/login').send({ email: a.email, password });
const verify = (challengeToken, code) => api().post('/api/v1/admin/auth/verify-otp').send({ challengeToken, code });
const resend = (challengeToken) => api().post('/api/v1/admin/auth/resend-otp').send({ challengeToken });
const wrong = (code) => String((Number(code) + 1) % 1000000).padStart(6, '0');
const codeRow = async () => (await h.query('SELECT * FROM admin_login_codes ORDER BY id DESC LIMIT 1'))[0];
const backdateResend = () => h.query('UPDATE admin_login_codes SET last_sent_at = last_sent_at - INTERVAL 61 SECOND');

test('login emails a code; the admin token only comes after the correct code', async () => {
  const a = await h.makeAdmin('boss@example.org');
  // wrong password and unknown email: same generic error, no email sent
  const bad = await login(a, 'wrong-wrong-1');
  const unknown = await api().post('/api/v1/admin/auth/login').send({ email: 'nobody@example.org', password: a.password });
  assert.equal(bad.status, 401); assert.equal(unknown.status, 401);
  assert.deepEqual(bad.body, unknown.body);
  assert.equal(bad.body.error.code, 'INVALID_CREDENTIALS');
  assert.equal(h.outbox.length, 0);

  const l = await login(a);
  assert.equal(l.status, 200);
  assert.equal(l.body.step, 'email_otp');
  assert.ok(l.body.challengeToken);
  assert.equal(l.body.token, undefined);                       // no admin JWT yet
  // the challenge token is NOT an admin token
  assert.equal((await api().get('/api/v1/admin/auth/me').set(bearer(l.body.challengeToken))).status, 401);
  assert.equal((await api().get('/api/v1/admin/admins').set(bearer(l.body.challengeToken))).status, 401);

  // the email: fixed subject and text, the code and nothing else
  assert.equal(h.outbox.length, 1);
  const mail = h.outbox[0];
  assert.equal(mail.to, a.email);
  assert.equal(mail.subject, 'Your Satsang Spark admin login code');
  const code = h.lastAdminCode(a.email);
  assert.equal(mail.text, `Your login code is ${code}. It expires in 10 minutes. If you didn't try to log in, change your password.`);
  assert.equal(mail.html, undefined);
  assert.ok(!JSON.stringify(l.body).includes(code));

  // only a hash is stored, with a 10-minute expiry and attempts = 0
  const row = await codeRow();
  assert.ok(!JSON.stringify(row).includes(code));
  assert.equal(row.attempts, 0);
  const mins = (new Date(String(row.expires_at).replace(' ', 'T') + 'Z') - Date.now()) / 60000;
  assert.ok(mins > 9 && mins <= 10, String(mins));

  const v = await verify(l.body.challengeToken, code);
  assert.equal(v.status, 200);
  assert.equal(v.body.admin.role, 'full_admin');
  assert.ok(!JSON.stringify(v.body).includes(`"${code}"`));
  assert.equal((await api().get('/api/v1/admin/auth/me').set(bearer(v.body.token))).body.admin.email, a.email);
  assert.ok((await codeRow()).used_at);
  // single use: the same challenge cannot be verified again
  const again = await verify(l.body.challengeToken, code);
  assert.equal(again.status, 401); assert.equal(again.body.error.code, 'CHALLENGE_INVALID');
  assert.equal((await resend(l.body.challengeToken)).body.error.code, 'CHALLENGE_INVALID');

  // an admin token or a garbage string is not a challenge token
  assert.equal((await verify(v.body.token, code)).body.error.code, 'CHALLENGE_INVALID');
  assert.equal((await verify('nonsense', code)).body.error.code, 'CHALLENGE_INVALID');

  const actions = (await h.query('SELECT action FROM audit_log ORDER BY id')).map((r) => r.action);
  assert.deepEqual(actions, ['admin.login_failed', 'admin.login_code_sent', 'admin.login_success']);
});

test('the code is never returned in a response or written to the audit log', async () => {
  const a = await h.makeAdmin('boss@example.org');
  const bodies = [];
  const l = await login(a); bodies.push(l.body);
  const c1 = h.lastAdminCode(a.email);
  bodies.push((await verify(l.body.challengeToken, wrong(c1))).body);
  await backdateResend();
  const r = await resend(l.body.challengeToken); bodies.push(r.body);
  assert.equal(r.status, 200);
  const c2 = h.lastAdminCode(a.email);
  const v = await verify(l.body.challengeToken, c2); bodies.push(v.body);
  assert.equal(v.status, 200);
  // compare against the JSON values (the JWTs are base64 and could contain 6 digits by chance)
  const values = JSON.stringify(bodies, (k, x) => (k === 'challengeToken' || k === 'token' ? undefined : x));
  const log = JSON.stringify(await h.query('SELECT action, details FROM audit_log'));
  for (const c of [c1, c2]) { assert.ok(!values.includes(c), 'response'); assert.ok(!log.includes(c), 'audit'); }
  const actions = (await h.query('SELECT action FROM audit_log ORDER BY id')).map((x) => x.action);
  assert.deepEqual(actions, ['admin.login_code_sent', 'admin.login_code_failed', 'admin.login_code_sent', 'admin.login_success']);
});

test('5 wrong codes lock the challenge (log in again) and lock the account for 15 minutes', async () => {
  const a = await h.makeAdmin('boss@example.org');
  const l = await login(a);
  const code = h.lastAdminCode(a.email);
  for (let i = 0; i < 4; i++) {
    const w = await verify(l.body.challengeToken, wrong(code));
    assert.equal(w.status, 401); assert.equal(w.body.error.code, 'OTP_INVALID');
    assert.equal(w.body.error.details.attemptsLeft, 4 - i);
  }
  const fifth = await verify(l.body.challengeToken, wrong(code));
  assert.equal(fifth.status, 429); assert.equal(fifth.body.error.code, 'OTP_LOCKED');
  // even the right code no longer works, and no new code can be sent for this login
  const locked = await verify(l.body.challengeToken, code);
  assert.equal(locked.status, 429); assert.equal(locked.body.error.code, 'OTP_LOCKED');
  assert.equal(locked.body.token, undefined);
  await backdateResend();
  assert.equal((await resend(l.body.challengeToken)).body.error.code, 'OTP_LOCKED');
  // account lockout as before
  const relog = await login(a);
  assert.equal(relog.status, 429); assert.equal(relog.body.error.code, 'ADMIN_LOCKED');
  const actions = (await h.query('SELECT action FROM audit_log')).map((r) => r.action);
  assert.equal(actions.filter((x) => x === 'admin.login_code_failed').length, 5);
  assert.ok(actions.includes('admin.locked'));
  // after the lock ends, a fresh login works
  await h.query('UPDATE admins SET locked_until = UTC_TIMESTAMP() - INTERVAL 1 MINUTE');
  assert.ok((await h.adminLogin(a)).token);
});

test('an expired code fails with a clear error', async () => {
  const a = await h.makeAdmin('boss@example.org');
  const l = await login(a);
  await h.query('UPDATE admin_login_codes SET expires_at = UTC_TIMESTAMP() - INTERVAL 1 SECOND');
  const v = await verify(l.body.challengeToken, h.lastAdminCode(a.email));
  assert.equal(v.status, 401); assert.equal(v.body.error.code, 'OTP_EXPIRED');
  assert.match(v.body.error.message, /expired/);
  assert.equal(v.body.token, undefined);
  // a resend gives a fresh 10-minute code for the same login
  await backdateResend();
  assert.equal((await resend(l.body.challengeToken)).status, 200);
  assert.equal((await verify(l.body.challengeToken, h.lastAdminCode(a.email))).status, 200);
});

test('resend: 60-second cooldown, old code stops working, at most 5 per login', async () => {
  const a = await h.makeAdmin('boss@example.org');
  const l = await login(a);
  const first = h.lastAdminCode(a.email);
  const soon = await resend(l.body.challengeToken);
  assert.equal(soon.status, 429); assert.equal(soon.body.error.code, 'RESEND_TOO_SOON');
  assert.ok(soon.body.error.details.retryAfterSeconds > 0 && soon.body.error.details.retryAfterSeconds <= 60);
  assert.equal(h.outbox.length, 1);

  const codes = [first];
  for (let i = 0; i < 5; i++) {
    await backdateResend();
    const r = await resend(l.body.challengeToken);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.sent, true);
    assert.equal(r.body.resendsLeft, 4 - i);
    codes.push(h.lastAdminCode(a.email));
    // straight after a resend, the cooldown applies again
    assert.equal((await resend(l.body.challengeToken)).body.error.code, i < 4 ? 'RESEND_TOO_SOON' : 'RESEND_LIMIT');
  }
  await backdateResend();
  const sixth = await resend(l.body.challengeToken);
  assert.equal(sixth.status, 429); assert.equal(sixth.body.error.code, 'RESEND_LIMIT');
  assert.equal(h.outbox.length, 6);
  assert.equal((await codeRow()).resend_count, 5);

  const latest = codes[codes.length - 1];
  const older = codes.slice(0, -1).find((c) => c !== latest);
  if (older) assert.equal((await verify(l.body.challengeToken, older)).body.error.code, 'OTP_INVALID');
  assert.equal((await verify(l.body.challengeToken, latest)).status, 200);
});

test('a new login cancels the previous unfinished one; logout ends a pending challenge', async () => {
  const a = await h.makeAdmin('boss@example.org');
  const l1 = await login(a); const c1 = h.lastAdminCode(a.email);
  const l2 = await login(a);
  assert.equal((await verify(l1.body.challengeToken, c1)).body.error.code, 'CHALLENGE_INVALID');
  const t = await verify(l2.body.challengeToken, h.lastAdminCode(a.email));
  assert.equal(t.status, 200);
  const l3 = await login(a);
  await api().post('/api/v1/admin/auth/logout').set(bearer(t.body.token));        // token_version bump
  assert.equal((await verify(l3.body.challengeToken, h.lastAdminCode(a.email))).body.error.code, 'TOKEN_REVOKED');
});

test('the authenticator endpoints are gone', async () => {
  const a = await h.makeAdmin('boss@example.org');
  const l = await login(a);
  for (const p of ['/totp/setup', '/totp/enable', '/totp/verify']) {
    assert.equal((await api().post('/api/v1/admin/auth' + p).set(bearer(l.body.challengeToken)).send({ code: '123456' })).status, 404, p);
  }
  const b = await h.adminLogin(await h.makeAdmin('second@example.org'));
  assert.equal((await api().post(`/api/v1/admin/admins/${a.id}/reset-2fa`).set(bearer(b.token))).status, 404);
  assert.equal((await api().get('/api/v1/admin/auth/me').set(bearer(b.token))).body.admin.totpEnabled, undefined);
});

test('roles: Content Editor is limited; Full Admin manages admins', async () => {
  const boss = await h.makeAdmin('boss@example.org');
  const ed = await h.makeAdmin('editor@example.org', 'content_editor');
  const b = await h.adminLogin(boss); const e = await h.adminLogin(ed);
  for (const path of ['/admin/admins', '/admin/users', '/admin/audit-log']) {
    assert.equal((await api().get('/api/v1' + path).set(bearer(e.token))).status, 403, path);
    assert.equal((await api().get('/api/v1' + path).set(bearer(b.token))).status, 200, path);
  }
  assert.equal((await api().get('/api/v1/admin/blocked-words').set(bearer(e.token))).status, 200);
  assert.equal((await api().get('/api/v1/admin/admins')).status, 401);
  // app user tokens never work on admin routes
  const u = await h.adultLogin();
  assert.equal((await api().get('/api/v1/admin/admins').set(bearer(u.accessToken))).status, 401);

  const made = await api().post('/api/v1/admin/admins').set(bearer(b.token)).send({ email: 'NEW@example.org', name: 'New', role: 'content_editor', temporaryPassword: 'TemporaryPass123' });
  assert.equal(made.status, 201); assert.equal(made.body.admin.email, 'new@example.org');
  assert.equal((await api().post('/api/v1/admin/admins').set(bearer(b.token)).send({ email: 'new@example.org', role: 'content_editor', temporaryPassword: 'TemporaryPass123' })).status, 409);
  assert.equal((await api().post('/api/v1/admin/admins').set(bearer(b.token)).send({ email: 'x@example.org', role: 'content_editor', temporaryPassword: 'short' })).status, 400);
});

test('cannot remove the last Full Admin or deactivate yourself; changing role ends their sessions', async () => {
  const boss = await h.makeAdmin('boss@example.org'); const b = await h.adminLogin(boss);
  const second = await h.makeAdmin('second@example.org'); const s = await h.adminLogin(second);
  assert.equal((await api().patch(`/api/v1/admin/admins/${boss.id}`).set(bearer(b.token)).send({ isActive: false })).body.error.code, 'CANNOT_DEACTIVATE_SELF');
  assert.equal((await api().patch(`/api/v1/admin/admins/${second.id}`).set(bearer(b.token)).send({ role: 'content_editor' })).status, 200);
  assert.equal((await api().get('/api/v1/admin/auth/me').set(bearer(s.token))).status, 401);       // their old token is dead
  const demote = await api().patch(`/api/v1/admin/admins/${boss.id}`).set(bearer(b.token)).send({ role: 'content_editor' });
  assert.equal(demote.body.error.code, 'LAST_FULL_ADMIN');
  assert.equal((await api().patch(`/api/v1/admin/admins/${second.id}`).set(bearer(b.token)).send({ isActive: false })).status, 200);
  assert.equal((await api().post('/api/v1/admin/auth/login').send({ email: second.email, password: second.password })).status, 401);
});

test('reset password works', async () => {
  const boss = await h.makeAdmin('boss@example.org'); const b = await h.adminLogin(boss);
  const ed = await h.makeAdmin('editor@example.org', 'content_editor');
  assert.equal((await api().post(`/api/v1/admin/admins/${ed.id}/reset-password`).set(bearer(b.token)).send({ newPassword: 'BrandNewPassword1' })).status, 200);
  assert.equal((await api().post('/api/v1/admin/auth/login').send({ email: ed.email, password: 'BrandNewPassword1' })).status, 200);
});

test('admin can search users and manually set an age group; it is audited and survives refresh', async () => {
  const boss = await h.makeAdmin('boss@example.org'); const b = await h.adminLogin(boss);
  const u = await h.adultLogin('ravi@example.org', 'ravi_k');
  const s = await api().get('/api/v1/admin/users').set(bearer(b.token)).query({ q: 'ravi' });
  assert.equal(s.body.totalAccounts, 1);
  assert.equal(s.body.rows[0].username, 'ravi_k');
  assert.ok(!JSON.stringify(s.body).includes('password'));
  const pid = u.profiles[0].id;
  const detail = await api().get(`/api/v1/admin/users/${u.account.id}`).set(bearer(b.token));
  assert.ok(!JSON.stringify(detail.body).match(/password"|pin_hash/i));
  assert.equal(detail.body.account.email, 'ravi@example.org');
  assert.equal(detail.body.account.accountType, 'adult');
  assert.equal(detail.body.account.emailVerified, true);
  assert.equal(detail.body.account.parentPinSet, false);
  assert.equal(detail.body.profiles.length, 1);
  assert.equal(detail.body.profiles[0].username, 'ravi_k');
  assert.equal(detail.body.profiles[0].avatarKey, 'waddles');
  assert.equal(detail.body.profiles[0].age, 30);
  assert.equal(detail.body.profiles[0].ageGroupOverridden, false);
  assert.equal((await api().get('/api/v1/admin/users/999999').set(bearer(b.token))).status, 404);

  assert.equal((await api().patch(`/api/v1/admin/users/profiles/${pid}/age-group`).set(bearer(b.token)).send({ ageGroup: 'Vadil' })).status, 400); // reason required
  assert.equal((await api().patch(`/api/v1/admin/users/profiles/${pid}/age-group`).set(bearer(b.token)).send({ ageGroup: 'Nonsense', reason: 'test' })).status, 400);
  const ok = await api().patch(`/api/v1/admin/users/profiles/${pid}/age-group`).set(bearer(b.token)).send({ ageGroup: 'Vadil', reason: 'Parent request' });
  assert.equal(ok.body.ageGroup, 'Vadil');
  assert.equal((await api().get('/api/v1/me').set(bearer(u.accessToken))).body.profiles[0].ageGroup, 'Vadil');   // override beats DOB
  // clearing the override returns to the DOB-derived group
  await api().patch(`/api/v1/admin/users/profiles/${pid}/age-group`).set(bearer(b.token)).send({ ageGroup: null, reason: 'Undo' });
  assert.equal((await api().get('/api/v1/me').set(bearer(u.accessToken))).body.profiles[0].ageGroup, 'Yuvak/Yuvatis A');

  const log = await api().get('/api/v1/admin/audit-log').set(bearer(b.token)).query({ action: 'user.age_group_changed' });
  assert.equal(log.body.total, 2);
  assert.equal(log.body.entries[1].adminEmail, 'boss@example.org');
  assert.equal(log.body.entries[1].details.reason, 'Parent request');
});

test('blocked words: add Gujarati/transliterated words, they take effect immediately, removal is audited', async () => {
  const ed = await h.makeAdmin('editor@example.org', 'content_editor'); const e = await h.adminLogin(ed);
  const add = await api().post('/api/v1/admin/blocked-words').set(bearer(e.token)).send({ word: 'ગાળ', kind: 'blocked' });
  assert.equal(add.status, 201);
  assert.equal((await api().post('/api/v1/admin/blocked-words').set(bearer(e.token)).send({ word: 'ગાળ' })).status, 409);
  assert.equal((await api().get('/api/v1/usernames/check').query({ username: 'તુંગાળુ' })).body.reason, 'BLOCKED_WORD');
  assert.equal((await api().delete(`/api/v1/admin/blocked-words/${add.body.id}`).set(bearer(e.token))).status, 200);
  assert.equal((await api().get('/api/v1/usernames/check').query({ username: 'તુંગાળુ' })).body.available, true);
  const boss = await h.makeAdmin('boss@example.org'); const b = await h.adminLogin(boss);
  const log = await api().get('/api/v1/admin/audit-log').set(bearer(b.token)).query({ entityType: 'blocked_word' });
  assert.deepEqual(log.body.entries.map((x) => x.action).sort(), ['blocked_word.added', 'blocked_word.removed']);
});

test('logout and password change end admin sessions', async () => {
  const a = await h.makeAdmin('boss@example.org'); const t = await h.adminLogin(a);
  assert.equal((await api().post('/api/v1/admin/auth/logout').set(bearer(t.token))).status, 200);
  assert.equal((await api().get('/api/v1/admin/auth/me').set(bearer(t.token))).status, 401);
  const t2 = await h.adminLogin(a);
  assert.equal((await api().post('/api/v1/admin/auth/change-password').set(bearer(t2.token)).send({ currentPassword: 'AdminPassphrase1!', newPassword: 'short' })).status, 400);
  assert.equal((await api().post('/api/v1/admin/auth/change-password').set(bearer(t2.token)).send({ currentPassword: 'AdminPassphrase1!', newPassword: 'ABrandNewPassphrase9' })).status, 200);
  assert.equal((await api().get('/api/v1/admin/auth/me').set(bearer(t2.token))).status, 401);
});

test('admin deletes an account: needs confirm + reason, removes child profiles, ends sessions, is audited', async () => {
  const boss = await h.makeAdmin('boss@example.org'); const b = await h.adminLogin(boss);
  const ed = await h.makeAdmin('editor@example.org', 'content_editor'); const e = await h.adminLogin(ed);
  const parent = await h.parentLogin('parent@example.org');
  const c = await api().post('/api/v1/profiles').set(parent.auth)
    .send({ pin: '1234', username: 'kid_one', avatarId: 2, dob: h.dobYearsAgo(8), parentalConsent: true });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const id = parent.account.id;
  const url = `/api/v1/admin/users/${id}`;

  assert.equal((await api().delete(url).set(bearer(b.token)).send({ reason: 'Requested by email' })).status, 400);   // confirm missing
  assert.equal((await api().delete(url).set(bearer(b.token)).send({ confirm: true })).status, 400);                  // reason missing
  assert.equal((await api().delete(url).set(bearer(e.token)).send({ confirm: true, reason: 'Requested by email' })).status, 403);
  const r = await api().delete(url).set(bearer(b.token)).send({ confirm: true, reason: 'Requested by email' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { deleted: true, accountId: id, profilesDeleted: 1 });

  assert.equal((await h.query('SELECT COUNT(*) AS n FROM profiles'))[0].n, 0);
  assert.equal((await api().get('/api/v1/me').set(parent.auth)).status, 401);
  assert.equal((await api().get(url).set(bearer(b.token))).status, 404);
  assert.equal((await api().delete(url).set(bearer(b.token)).send({ confirm: true, reason: 'again' })).status, 404);
  const log = (await h.query("SELECT details FROM audit_log WHERE action = 'user.deleted'"))[0];
  assert.equal(log.details.reason, 'Requested by email');
  assert.ok(!JSON.stringify(log.details).includes('parent@example.org'), 'no email kept after deletion');
});
