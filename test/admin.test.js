const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { authenticator } = require('otplib');
const h = require('./helpers');
const { api, bearer } = h;

beforeEach(h.resetDb);
after(() => h.pool.end());

test('first login forces 2FA enrolment; later logins need a valid code', async () => {
  const a = await h.makeAdmin('boss@example.org');
  assert.equal((await api().post('/api/v1/admin/auth/login').send({ email: a.email, password: 'wrong-wrong-1' })).status, 401);
  const l = await api().post('/api/v1/admin/auth/login').send({ email: a.email, password: a.password });
  assert.equal(l.body.step, 'totp_setup');
  // a step token is NOT an admin token
  assert.equal((await api().get('/api/v1/admin/auth/me').set(bearer(l.body.stepToken))).status, 401);
  assert.equal((await api().get('/api/v1/admin/admins').set(bearer(l.body.stepToken))).status, 401);
  const s = await api().post('/api/v1/admin/auth/totp/setup').set(bearer(l.body.stepToken));
  assert.ok(s.body.secret && s.body.qrDataUrl.startsWith('data:image/png'));
  assert.equal((await api().post('/api/v1/admin/auth/totp/enable').set(bearer(l.body.stepToken)).send({ code: '000000' })).status, 401);
  const e = await api().post('/api/v1/admin/auth/totp/enable').set(bearer(l.body.stepToken)).send({ code: authenticator.generate(s.body.secret) });
  assert.equal(e.status, 200);
  assert.equal((await api().get('/api/v1/admin/auth/me').set(bearer(e.body.token))).body.admin.role, 'full_admin');

  const l2 = await api().post('/api/v1/admin/auth/login').send({ email: a.email, password: a.password });
  assert.equal(l2.body.step, 'totp_verify');
  assert.equal((await api().post('/api/v1/admin/auth/totp/verify').set(bearer(l2.body.stepToken)).send({ code: '123456' })).status, 401);
  const v = await api().post('/api/v1/admin/auth/totp/verify').set(bearer(l2.body.stepToken)).send({ code: authenticator.generate(s.body.secret) });
  assert.equal(v.status, 200);
  // TOTP secret is stored encrypted, not in plain text
  const stored = (await h.query('SELECT totp_secret_enc FROM admins'))[0].totp_secret_enc;
  assert.ok(stored && !stored.includes(s.body.secret));
});

test('5 wrong codes lock the admin account for 15 minutes', async () => {
  const a = await h.makeAdmin('boss@example.org');
  const { secret } = await h.adminLogin(a);
  const l = await api().post('/api/v1/admin/auth/login').send({ email: a.email, password: a.password });
  for (let i = 0; i < 5; i++) assert.equal((await api().post('/api/v1/admin/auth/totp/verify').set(bearer(l.body.stepToken)).send({ code: '000000' })).status, 401);
  const locked = await api().post('/api/v1/admin/auth/totp/verify').set(bearer(l.body.stepToken)).send({ code: authenticator.generate(secret) });
  assert.equal(locked.status, 429);
  assert.equal((await api().post('/api/v1/admin/auth/login').send({ email: a.email, password: a.password })).status, 429);
  const actions = (await h.query('SELECT action FROM audit_log')).map((r) => r.action);
  assert.ok(actions.includes('admin.locked') && actions.includes('admin.login_failed'));
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

test('reset 2FA forces re-enrolment; reset password works', async () => {
  const boss = await h.makeAdmin('boss@example.org'); const b = await h.adminLogin(boss);
  const ed = await h.makeAdmin('editor@example.org', 'content_editor'); const e = await h.adminLogin(ed);
  assert.equal((await api().post(`/api/v1/admin/admins/${ed.id}/reset-2fa`).set(bearer(b.token))).status, 200);
  assert.equal((await api().get('/api/v1/admin/auth/me').set(bearer(e.token))).status, 401);
  assert.equal((await api().post('/api/v1/admin/auth/login').send({ email: ed.email, password: ed.password })).body.step, 'totp_setup');
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
  assert.ok(!JSON.stringify(detail.body).match(/password|pin_hash/i));

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
  const t2 = await h.adminLogin(a, t.secret);
  assert.equal((await api().post('/api/v1/admin/auth/change-password').set(bearer(t2.token)).send({ currentPassword: 'AdminPassphrase1!', newPassword: 'short' })).status, 400);
  assert.equal((await api().post('/api/v1/admin/auth/change-password').set(bearer(t2.token)).send({ currentPassword: 'AdminPassphrase1!', newPassword: 'ABrandNewPassphrase9' })).status, 200);
  assert.equal((await api().get('/api/v1/admin/auth/me').set(bearer(t2.token))).status, 401);
});
