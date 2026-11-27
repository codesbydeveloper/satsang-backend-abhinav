const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { api, bearer } = h;
const mailer = require('../src/utils/mailer');
const { deviceLabel } = require('../src/utils/adminSessions');

beforeEach(h.resetDb);
after(() => h.pool.end());

const CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SAFARI_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const ALERT = 'Satsang Spark Admin – new sign-in';
const CODE_SUBJECT = /^\d{6} is your Satsang Spark admin login code$/;

const login = (a, extra = {}, ua = CHROME_WIN) =>
  api().post('/api/v1/admin/auth/login').set('User-Agent', ua).send({ email: a.email, password: a.password, ...extra });
const verify = (challengeToken, code, extra = {}, ua = CHROME_WIN) =>
  api().post('/api/v1/admin/auth/verify-otp').set('User-Agent', ua).send({ challengeToken, code, ...extra });
const refresh = (refreshToken) => api().post('/api/v1/admin/auth/refresh').send({ refreshToken });
const codeMails = (to) => h.outbox.filter((m) => m.to === to && CODE_SUBJECT.test(m.subject)).length;
const alerts = () => h.outbox.filter((m) => m.subject === ALERT);
const actions = async () => (await h.query('SELECT action, details FROM audit_log ORDER BY id'));

/** Password + code with trustDevice: true. Returns the verify body (token, deviceToken, device, ...). */
async function trustedLogin(a, extra = {}, ua = CHROME_WIN) {
  const l = await login(a, extra, ua);
  assert.equal(l.body.step, 'email_otp', JSON.stringify(l.body));
  const v = await verify(l.body.challengeToken, h.lastAdminCode(a.email), { trustDevice: true }, ua);
  assert.equal(v.status, 200, JSON.stringify(v.body));
  return v.body;
}

test('device labels come from the user agent (browser + OS only)', () => {
  assert.equal(deviceLabel(CHROME_WIN), 'Chrome on Windows');
  assert.equal(deviceLabel(SAFARI_MAC), 'Safari on macOS');
  assert.equal(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'), 'Edge on Windows');
  assert.equal(deviceLabel('Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0'), 'Firefox on Linux');
  assert.equal(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'), 'Safari on iOS');
  assert.equal(deviceLabel('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'), 'Chrome on Android');
  assert.equal(deviceLabel(''), 'Unknown device');
  assert.equal(deviceLabel('curl/8.4.0'), 'Unknown device');
});

test('trusted device: code only on the first login from a new device, then password only', async () => {
  const a = await h.makeAdmin('boss@example.org');
  const first = await trustedLogin(a);
  assert.equal(first.step, 'done');
  assert.ok(first.token);
  assert.match(first.deviceToken, /^[A-Za-z0-9_-]{60,}$/);              // long, URL-safe
  assert.equal(first.device.label, 'Chrome on Windows');
  assert.equal(codeMails(a.email), 1);

  // only a hash is stored
  const row = (await h.query('SELECT * FROM admin_trusted_devices'))[0];
  assert.equal(row.admin_id, a.id);
  assert.notEqual(row.token_hash, first.deviceToken);
  assert.ok(!JSON.stringify(row).includes(first.deviceToken));
  await h.query('UPDATE admin_trusted_devices SET last_used_at = NULL');

  // same device: password only, no code email, step "done"
  const again = await login(a, { deviceToken: first.deviceToken });
  assert.equal(again.status, 200);
  assert.equal(again.body.step, 'done');
  assert.equal(again.body.challengeToken, undefined);
  assert.equal(again.body.deviceToken, undefined);                      // the device token is returned only once
  assert.equal(again.body.device.id, first.device.id);
  assert.equal(codeMails(a.email), 1);
  assert.equal((await api().get('/api/v1/admin/auth/me').set(bearer(again.body.token))).body.admin.email, a.email);
  assert.ok((await h.query('SELECT last_used_at FROM admin_trusted_devices'))[0].last_used_at);

  // the password is still required, and failures still count
  const bad = await login(a, { deviceToken: first.deviceToken, password: 'wrong-wrong-1' });
  assert.equal(bad.status, 401); assert.equal(bad.body.error.code, 'INVALID_CREDENTIALS');

  // an unknown token → normal code step, flagged so the panel can forget it
  const unknown = await login(a, { deviceToken: 'not-a-real-device-token' });
  assert.equal(unknown.body.step, 'email_otp');
  assert.equal(unknown.body.deviceTokenInvalid, true);
  // without a token → no flag
  assert.equal((await login(a)).body.deviceTokenInvalid, undefined);

  // a device token only works for the admin who trusted it
  const other = await h.makeAdmin('second@example.org');
  const o = await login(other, { deviceToken: first.deviceToken });
  assert.equal(o.body.step, 'email_otp');

  // audit: device_trusted once, login_success with the method; no token anywhere in the log
  const log = await actions();
  const success = log.filter((x) => x.action === 'admin.login_success').map((x) => x.details.method);
  assert.deepEqual(success, ['otp', 'trusted_device']);
  const trusted = log.filter((x) => x.action === 'admin.device_trusted');
  assert.equal(trusted.length, 1);
  assert.deepEqual(trusted[0].details, { deviceId: first.device.id, label: 'Chrome on Windows' });
  const all = JSON.stringify(log);
  assert.ok(!all.includes(first.deviceToken));
  assert.ok(!all.includes(first.token));
});

test('verify-otp without trustDevice trusts nothing; the next login needs a code again', async () => {
  const a = await h.makeAdmin('boss@example.org');
  const l = await login(a);
  const v = await verify(l.body.challengeToken, h.lastAdminCode(a.email));
  assert.equal(v.status, 200);
  assert.equal(v.body.step, 'done');
  assert.equal(v.body.deviceToken, undefined);
  assert.equal((await h.query('SELECT COUNT(*) AS n FROM admin_trusted_devices'))[0].n, 0);
  assert.equal((await login(a)).body.step, 'email_otp');
});

test('own devices: list and revoke; a revoked device needs the code again', async () => {
  const a = await h.makeAdmin('editor@example.org', 'content_editor');      // any role manages its own devices
  const d1 = await trustedLogin(a);
  const d2 = await trustedLogin(a, {}, SAFARI_MAC);
  const auth = bearer(d2.token);

  const list = await api().get('/api/v1/admin/me/devices').set(auth);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.devices.map((d) => d.label), ['Safari on macOS', 'Chrome on Windows']);
  assert.deepEqual(Object.keys(list.body.devices[0]).sort(), ['createdAt', 'id', 'label', 'lastUsedAt']);
  assert.ok(!JSON.stringify(list.body).includes(d1.deviceToken));

  // someone else's device is not yours
  const other = await h.makeAdmin('boss@example.org');
  const od = await trustedLogin(other);
  assert.equal((await api().delete(`/api/v1/admin/me/devices/${od.device.id}`).set(auth)).status, 404);

  const del = await api().delete(`/api/v1/admin/me/devices/${d1.device.id}`).set(auth);
  assert.equal(del.status, 200);
  assert.equal((await api().delete(`/api/v1/admin/me/devices/${d1.device.id}`).set(auth)).status, 404);   // already revoked
  assert.deepEqual((await api().get('/api/v1/admin/me/devices').set(auth)).body.devices.map((d) => d.id), [d2.device.id]);
  assert.equal((await login(a, { deviceToken: d1.deviceToken })).body.step, 'email_otp');
  assert.equal((await login(a, { deviceToken: d2.deviceToken }, SAFARI_MAC)).body.step, 'done');

  const revoked = (await actions()).filter((x) => x.action === 'admin.device_revoked');
  assert.equal(revoked.length, 1);
  assert.deepEqual(revoked[0].details, { deviceId: d1.device.id, reason: 'self' });

  assert.equal((await api().get('/api/v1/admin/me/devices')).status, 401);
});

test('Full Admin lists and revokes another admin\'s devices; Content Editors cannot', async () => {
  const boss = await h.makeAdmin('boss@example.org'); const b = await h.adminLogin(boss);
  const ed = await h.makeAdmin('editor@example.org', 'content_editor');
  const e1 = await trustedLogin(ed);
  const e2 = await trustedLogin(ed, {}, SAFARI_MAC);
  const e3 = await trustedLogin(ed);

  const base = `/api/v1/admin/admins/${ed.id}/devices`;
  assert.equal((await api().get(base).set(bearer(e3.token))).status, 403);
  assert.equal((await api().delete(base).set(bearer(e3.token))).status, 403);
  assert.equal((await api().delete(`${base}/${e1.device.id}`).set(bearer(e3.token))).status, 403);
  assert.equal((await api().get('/api/v1/admin/admins/9999/devices').set(bearer(b.token))).status, 404);

  assert.equal((await api().get(base).set(bearer(b.token))).body.devices.length, 3);
  assert.equal((await api().delete(`${base}/${e1.device.id}`).set(bearer(b.token))).status, 200);
  assert.equal((await api().delete(`${base}/${e1.device.id}`).set(bearer(b.token))).status, 404);
  assert.equal((await login(ed, { deviceToken: e1.deviceToken })).body.step, 'email_otp');

  const all = await api().delete(base).set(bearer(b.token));
  assert.deepEqual(all.body, { ok: true, revoked: 2 });
  assert.equal((await api().get(base).set(bearer(b.token))).body.devices.length, 0);
  assert.equal((await login(ed, { deviceToken: e2.deviceToken }, SAFARI_MAC)).body.step, 'email_otp');

  const revoked = (await actions()).filter((x) => x.action === 'admin.device_revoked').map((x) => x.details);
  assert.deepEqual(revoked, [{ deviceId: e1.device.id, reason: 'full_admin' }, { all: true, count: 2, reason: 'full_admin' }]);
});

test('at most 10 trusted devices per admin: the oldest is revoked', async () => {
  const a = await h.makeAdmin('boss@example.org');
  const devices = [];
  for (let i = 0; i < 11; i++) devices.push(await trustedLogin(a));
  const live = await h.query('SELECT id FROM admin_trusted_devices WHERE revoked_at IS NULL ORDER BY id');
  assert.equal(live.length, 10);
  assert.ok(!live.some((r) => r.id === devices[0].device.id));
  assert.equal((await login(a, { deviceToken: devices[0].deviceToken })).body.step, 'email_otp');
  assert.equal((await login(a, { deviceToken: devices[1].deviceToken })).body.step, 'done');
  const limit = (await actions()).filter((x) => x.action === 'admin.device_revoked');
  assert.deepEqual(limit.map((x) => x.details), [{ deviceId: devices[0].device.id, reason: 'device_limit' }]);
});

test('password change, password reset, deactivation and role change revoke every trusted device', async () => {
  const boss = await h.makeAdmin('boss@example.org'); const b = await h.adminLogin(boss);
  const ed = await h.makeAdmin('editor@example.org', 'content_editor');
  const stillTrusted = async (who, tok) => (await login(who, { deviceToken: tok })).body.step === 'done';

  // own password change
  let d = await trustedLogin(ed);
  assert.equal((await api().post('/api/v1/admin/auth/change-password').set(bearer(d.token))
    .send({ currentPassword: ed.password, newPassword: 'ABrandNewPassphrase9' })).status, 200);
  ed.password = 'ABrandNewPassphrase9';
  assert.equal(await stillTrusted(ed, d.deviceToken), false);

  // reset by a Full Admin
  d = await trustedLogin(ed);
  assert.equal((await api().post(`/api/v1/admin/admins/${ed.id}/reset-password`).set(bearer(b.token)).send({ newPassword: 'AnotherPassphrase77' })).status, 200);
  ed.password = 'AnotherPassphrase77';
  assert.equal(await stillTrusted(ed, d.deviceToken), false);

  // role change
  d = await trustedLogin(ed);
  assert.equal((await api().patch(`/api/v1/admin/admins/${ed.id}`).set(bearer(b.token)).send({ role: 'full_admin' })).status, 200);
  assert.equal(await stillTrusted(ed, d.deviceToken), false);

  // deactivation (then reactivation: the old device is still revoked)
  d = await trustedLogin(ed);
  assert.equal((await api().patch(`/api/v1/admin/admins/${ed.id}`).set(bearer(b.token)).send({ active: false })).status, 200);
  assert.equal((await login(ed, { deviceToken: d.deviceToken })).status, 401);
  assert.equal((await api().patch(`/api/v1/admin/admins/${ed.id}`).set(bearer(b.token)).send({ active: true })).status, 200);
  assert.equal(await stillTrusted(ed, d.deviceToken), false);

  // a rename does not revoke anything
  d = await trustedLogin(ed);
  assert.equal((await api().patch(`/api/v1/admin/admins/${ed.id}`).set(bearer(b.token)).send({ name: 'New name' })).status, 200);
  assert.equal(await stillTrusted(ed, d.deviceToken), true);

  const reasons = (await actions()).filter((x) => x.action === 'admin.device_revoked').map((x) => x.details.reason);
  assert.deepEqual(reasons, ['password_changed', 'password_reset', 'role_changed', 'deactivated']);
});

test('remember me: 30-day rolling refresh token; refresh rotates; without it no refresh token', async () => {
  const a = await h.makeAdmin('boss@example.org');

  // rememberMe false (default): short session as before
  const l0 = await login(a);
  const v0 = await verify(l0.body.challengeToken, h.lastAdminCode(a.email));
  assert.equal(v0.body.rememberMe, false);
  assert.equal(v0.body.refreshToken, null);
  assert.equal((await h.query('SELECT COUNT(*) AS n FROM admin_refresh_tokens'))[0].n, 0);

  // rememberMe true (chosen on the login step, carried by the challenge)
  const l = await login(a, { rememberMe: true });
  const v = await verify(l.body.challengeToken, h.lastAdminCode(a.email));
  assert.equal(v.body.rememberMe, true);
  assert.match(v.body.refreshToken, /^[A-Za-z0-9_-]{60,}$/);
  const days = (new Date(v.body.refreshExpiresAt) - Date.now()) / 86400000;
  assert.ok(days > 29.9 && days <= 30, String(days));
  const row = (await h.query('SELECT * FROM admin_refresh_tokens'))[0];
  assert.ok(!JSON.stringify(row).includes(v.body.refreshToken));          // hash only

  await h.flushLoginAlerts();
  const mailsBefore = h.outbox.length;
  const logBefore = (await actions()).length;

  // refresh: a new admin token and a new refresh token; the old refresh token stops working
  await h.query('UPDATE admin_refresh_tokens SET expires_at = UTC_TIMESTAMP() + INTERVAL 1 DAY');   // rolling: restarts at 30 days
  const r1 = await refresh(v.body.refreshToken);
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.ok(r1.body.token);
  assert.equal(r1.body.admin.email, a.email);
  assert.notEqual(r1.body.refreshToken, v.body.refreshToken);
  assert.ok((new Date(r1.body.refreshExpiresAt) - Date.now()) / 86400000 > 29.9);
  assert.equal((await api().get('/api/v1/admin/auth/me').set(bearer(r1.body.token))).status, 200);
  const reuse = await refresh(v.body.refreshToken);
  assert.equal(reuse.status, 401); assert.equal(reuse.body.error.code, 'REFRESH_INVALID');
  const r2 = await refresh(r1.body.refreshToken);
  assert.equal(r2.status, 200);

  // a refresh is not a new sign-in: no alert email, no audit entry
  await h.flushLoginAlerts();
  assert.equal(h.outbox.length, mailsBefore);
  assert.equal((await actions()).length, logBefore);

  // expired → 401
  await h.query('UPDATE admin_refresh_tokens SET expires_at = UTC_TIMESTAMP() - INTERVAL 1 SECOND');
  assert.equal((await refresh(r2.body.refreshToken)).body.error.code, 'REFRESH_INVALID');
  assert.equal((await refresh('garbage')).status, 401);
  assert.equal((await api().post('/api/v1/admin/auth/refresh').send({})).status, 400);
});

test('remember me also works on a trusted device; logout revokes the refresh token but not the trusted device', async () => {
  const a = await h.makeAdmin('boss@example.org');
  const d = await trustedLogin(a);
  const l = await login(a, { deviceToken: d.deviceToken, rememberMe: true });
  assert.equal(l.body.step, 'done');
  assert.ok(l.body.refreshToken);

  assert.equal((await api().post('/api/v1/admin/auth/logout').set(bearer(l.body.token))).status, 200);
  assert.equal((await api().get('/api/v1/admin/auth/me').set(bearer(l.body.token))).status, 401);
  assert.equal((await refresh(l.body.refreshToken)).body.error.code, 'REFRESH_INVALID');
  assert.ok((await h.query('SELECT revoked_at FROM admin_refresh_tokens'))[0].revoked_at);
  // the device is still trusted
  assert.equal((await login(a, { deviceToken: d.deviceToken })).body.step, 'done');
});

test('refresh tokens stop after a password change, deactivation or role change', async () => {
  const boss = await h.makeAdmin('boss@example.org'); const b = await h.adminLogin(boss);
  const ed = await h.makeAdmin('editor@example.org', 'content_editor');
  const remembered = async () => {
    const l = await login(ed, { rememberMe: true });
    return (await verify(l.body.challengeToken, h.lastAdminCode(ed.email))).body;
  };
  let s = await remembered();
  await api().post(`/api/v1/admin/admins/${ed.id}/reset-password`).set(bearer(b.token)).send({ newPassword: 'AnotherPassphrase77' });
  ed.password = 'AnotherPassphrase77';
  assert.equal((await refresh(s.refreshToken)).status, 401);

  s = await remembered();
  await api().patch(`/api/v1/admin/admins/${ed.id}`).set(bearer(b.token)).send({ active: false });
  assert.equal((await refresh(s.refreshToken)).status, 401);
  await api().patch(`/api/v1/admin/admins/${ed.id}`).set(bearer(b.token)).send({ active: true });
  assert.equal((await refresh(s.refreshToken)).status, 401);

  s = await remembered();
  await api().patch(`/api/v1/admin/admins/${ed.id}`).set(bearer(b.token)).send({ role: 'full_admin' });
  assert.equal((await refresh(s.refreshToken)).status, 401);
});

test('login alert: every active Full Admin is emailed on a new sign-in, at most once per admin per 10 minutes', async () => {
  const boss = await h.makeAdmin('boss@example.org');
  const boss2 = await h.makeAdmin('boss2@example.org');
  const off = await h.makeAdmin('off@example.org');
  await h.query('UPDATE admins SET is_active = 0 WHERE id = ?', [off.id]);
  const ed = await h.makeAdmin('editor@example.org', 'content_editor');
  await h.query("UPDATE admins SET name = 'Meera Shah' WHERE id = ?", [ed.id]);

  const d = await trustedLogin(ed);
  await h.flushLoginAlerts();
  const sent = alerts();
  assert.deepEqual(sent.map((m) => m.to).sort(), [boss.email, boss2.email].sort());   // not the editor, not inactive admins
  const m = sent[0];
  assert.match(m.text, /Who: Meera Shah \(editor@example\.org\), Content Editor/);
  assert.match(m.text, /When: \d{2} \w{3} \d{4}, \d{2}:\d{2}:\d{2} IST \(Asia\/Kolkata\) · \d{2} \w{3} \d{4}, \d{2}:\d{2}:\d{2} UTC/);
  assert.match(m.text, /Device: Chrome on Windows/);
  assert.ok(m.text.includes("If this wasn't expected, deactivate the admin in the panel."));
  // the shared branded layout
  assert.match(m.html, /<!doctype html>/);
  assert.ok(m.html.includes('Satsang Spark'));
  assert.ok(m.html.includes('Meera Shah'));
  assert.ok(m.html.includes('If this wasn&#39;t expected, deactivate the admin in the panel.'));
  // no tokens, codes or IP in the alert
  for (const secret of [d.token, d.deviceToken, '127.0.0.1', '::ffff']) assert.ok(!m.text.includes(secret) && !m.html.includes(secret));

  // a second sign-in within 10 minutes (here on the trusted device): no new alert
  assert.equal((await login(ed, { deviceToken: d.deviceToken })).body.step, 'done');
  await h.flushLoginAlerts();
  assert.equal(alerts().length, 2);

  // 10 minutes later: alerts again (trusted-device logins alert too)
  await h.query('UPDATE admins SET last_login_alert_at = last_login_alert_at - INTERVAL 10 MINUTE WHERE id = ?', [ed.id]);
  assert.equal((await login(ed, { deviceToken: d.deviceToken })).body.step, 'done');
  await h.flushLoginAlerts();
  assert.equal(alerts().length, 4);

  // the rate limit is per signed-in admin: a Full Admin's own sign-in alerts too (including themselves)
  await h.adminLogin(boss);
  await h.flushLoginAlerts();
  assert.equal(alerts().length, 6);

  // the password step alone (code not entered yet) is not a sign-in
  await h.query('UPDATE admins SET last_login_alert_at = NULL');
  await login(ed);
  await h.flushLoginAlerts();
  assert.equal(alerts().length, 6);
});

test('a failing alert email never blocks or fails the login', async () => {
  await h.makeAdmin('boss@example.org');
  const ed = await h.makeAdmin('editor@example.org', 'content_editor');
  const original = mailer.sendAdminLoginAlert;
  const origError = console.error;
  const errors = [];
  mailer.sendAdminLoginAlert = async () => { throw new Error('SMTP down'); };
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const l = await login(ed);
    const v = await verify(l.body.challengeToken, h.lastAdminCode(ed.email));
    assert.equal(v.status, 200);
    assert.ok(v.body.token);
    await h.flushLoginAlerts();
  } finally {
    mailer.sendAdminLoginAlert = original;
    console.error = origError;
  }
  assert.ok(errors.some((e) => e.includes('ADMIN LOGIN ALERT EMAIL FAILED')));
  assert.equal(alerts().length, 0);
});

test('Full Admin limit: at most 3 (active + invited); beyond it 409 FULL_ADMIN_LIMIT', async () => {
  const boss = await h.makeAdmin('boss@example.org'); const b = await h.adminLogin(boss);
  const f2 = await h.makeAdmin('f2@example.org');
  const ed = await h.makeAdmin('editor@example.org', 'content_editor');
  const auth = bearer(b.token);
  const invite = (email, role) => api().post('/api/v1/admin/admins').set(auth).send({ email, name: 'X', role });

  assert.deepEqual((await api().get('/api/v1/admin/admins').set(auth)).body.fullAdminLimit, { max: 3, used: 2 });

  // an invited Full Admin counts
  const inv = await invite('f3@example.org', 'full_admin');
  assert.equal(inv.status, 201);
  assert.deepEqual((await api().get('/api/v1/admin/admins').set(auth)).body.fullAdminLimit, { max: 3, used: 3 });

  const over = await invite('f4@example.org', 'full_admin');
  assert.equal(over.status, 409); assert.equal(over.body.error.code, 'FULL_ADMIN_LIMIT');
  assert.equal((await h.query("SELECT COUNT(*) AS n FROM admins WHERE email = 'f4@example.org'"))[0].n, 0);
  assert.equal((await invite('ce@example.org', 'content_editor')).status, 201);      // Content Editors: no limit

  // promoting a Content Editor (active or invited)
  const promote = await api().patch(`/api/v1/admin/admins/${ed.id}`).set(auth).send({ role: 'full_admin' });
  assert.equal(promote.status, 409); assert.equal(promote.body.error.code, 'FULL_ADMIN_LIMIT');
  assert.equal((await h.query('SELECT role FROM admins WHERE id = ?', [ed.id]))[0].role, 'content_editor');

  // cancelling the invite frees a place
  assert.equal((await api().delete(`/api/v1/admin/admins/${inv.body.admin.id}`).set(auth)).status, 200);
  assert.equal((await api().patch(`/api/v1/admin/admins/${ed.id}`).set(auth).send({ role: 'full_admin' })).status, 200);

  // a deactivated Full Admin does not count, but reactivating one needs a free place
  assert.equal((await api().patch(`/api/v1/admin/admins/${f2.id}`).set(auth).send({ active: false })).status, 200);
  assert.deepEqual((await api().get('/api/v1/admin/admins').set(auth)).body.fullAdminLimit, { max: 3, used: 2 });
  assert.equal((await invite('f5@example.org', 'full_admin')).status, 201);
  const back = await api().patch(`/api/v1/admin/admins/${f2.id}`).set(auth).send({ active: true });
  assert.equal(back.status, 409); assert.equal(back.body.error.code, 'FULL_ADMIN_LIMIT');
  // reactivating as a Content Editor is fine
  assert.equal((await api().patch(`/api/v1/admin/admins/${f2.id}`).set(auth).send({ active: true, role: 'content_editor' })).status, 200);
  // renaming a Full Admin when at the limit is fine (it does not add one)
  assert.equal((await api().patch(`/api/v1/admin/admins/${ed.id}`).set(auth).send({ name: 'Renamed' })).status, 200);
});

test('Content Editors get 403 on users, exports, deletions, admins, audit log, settings and dashboard', async () => {
  const boss = await h.makeAdmin('boss@example.org'); await h.adminLogin(boss);
  const ed = await h.makeAdmin('editor@example.org', 'content_editor'); const e = await h.adminLogin(ed);
  const auth = bearer(e.token);
  const calls = [
    ['get', '/admin/users'], ['get', '/admin/users/1'], ['delete', '/admin/users/1'], ['patch', '/admin/users/profiles/1/age-group'],
    ['post', '/admin/profiles/1/student-status'],
    ['get', '/admin/deletion-requests'], ['get', '/admin/deletion-requests/1'], ['post', '/admin/deletion-requests/1/approve'], ['post', '/admin/deletion-requests/1/reject'],
    ['get', '/admin/admins'], ['post', '/admin/admins'], ['patch', `/admin/admins/${boss.id}`], ['delete', `/admin/admins/${boss.id}`],
    ['post', `/admin/admins/${boss.id}/resend-invite`], ['post', `/admin/admins/${boss.id}/reset-password`],
    ['get', `/admin/admins/${boss.id}/devices`], ['delete', `/admin/admins/${boss.id}/devices`], ['delete', `/admin/admins/${boss.id}/devices/1`],
    ['get', '/admin/audit-log'], ['get', '/admin/dashboard'],
    ['get', '/admin/referrals'], ['get', '/admin/referrals/settings'], ['put', '/admin/referrals/settings'],
  ];
  for (const [method, path] of calls) {
    const r = await api()[method]('/api/v1' + path).set(auth).send({});
    assert.equal(r.status, 403, `${method.toUpperCase()} ${path} → ${r.status}`);
    assert.equal(r.body.error.code, 'ROLE_FORBIDDEN');
  }
  // what a Content Editor may use
  assert.equal((await api().get('/api/v1/admin/blocked-words').set(auth)).status, 200);
  assert.equal((await api().get('/api/v1/admin/me/devices').set(auth)).status, 200);
  assert.equal((await api().get('/api/v1/admin/auth/me').set(auth)).status, 200);
});
