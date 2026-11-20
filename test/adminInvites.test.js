const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');
const h = require('./helpers');
const mailer = require('../src/utils/mailer');
const { api, bearer } = h;

beforeEach(h.resetDb);
after(() => h.pool.end());

const SUBJECT = "You've been invited to the Satsang Spark Admin Panel";
const lastInvite = (to) => [...h.outbox].reverse().find((m) => m.to === to && m.subject === SUBJECT);
const tokenOf = (mail) => mail.text.match(/\/accept-invite\?token=([A-Za-z0-9_-]+)/)[1];
const invite = (auth, body) => api().post('/api/v1/admin/admins').set(auth).send(body);
const checkInvite = (token) => api().get(`/api/v1/admin/auth/invite/${token}`);
const accept = (token, password) => api().post('/api/v1/admin/auth/accept-invite').send({ token, password });
const listed = async (auth, email) => (await api().get('/api/v1/admin/admins').set(auth)).body.admins.find((a) => a.email === email);
const actions = async () => (await h.query('SELECT action FROM audit_log ORDER BY id')).map((r) => r.action);
const PASSWORD = 'MyOwnPassphrase42';

async function boss() {
  const a = await h.makeAdmin('boss@example.org');
  const t = await h.adminLogin(a);
  return { ...a, auth: bearer(t.token) };
}

test('invite → email → check link → choose password → normal login (password + email code)', async () => {
  const b = await boss();
  const r = await invite(b.auth, { email: 'Editor@Example.org', name: 'Priya', role: 'content_editor' });
  assert.equal(r.status, 201);
  const ad = r.body.admin;
  assert.equal(ad.email, 'editor@example.org');
  assert.equal(ad.status, 'invited');
  assert.equal(ad.isActive, false);
  const hours = (new Date(ad.inviteExpiresAt) - Date.now()) / 3600000;
  assert.ok(hours > 47.9 && hours <= 48, String(hours));

  // the email: name, who invited, role, link to the panel, 48 hours
  const mail = lastInvite('editor@example.org');
  assert.ok(mail, 'invite email sent');
  assert.match(mail.text, /Hello Priya,/);
  assert.match(mail.text, /boss has invited you to the Satsang Spark Admin Panel as Content Editor\./);
  assert.match(mail.text, /http:\/\/localhost:5173\/accept-invite\?token=[A-Za-z0-9_-]{40,}/);
  assert.match(mail.text, /This link expires in 48 hours\./);
  const token = tokenOf(mail);

  // the token is never in a response, the DB (hash only) or the audit log
  assert.ok(!JSON.stringify(r.body).includes(token));
  const row = (await h.query('SELECT * FROM admins WHERE id = ?', [ad.id]))[0];
  assert.equal(row.password_hash, null);
  assert.ok(row.invite_token_hash && !JSON.stringify(row).includes(token));
  assert.ok(!JSON.stringify(await api().get('/api/v1/admin/admins').set(b.auth).then((x) => x.body)).match(/invite_token|token_hash/));

  // an invited admin cannot log in (same generic error as a wrong password)
  const early = await api().post('/api/v1/admin/auth/login').send({ email: 'editor@example.org', password: PASSWORD });
  assert.equal(early.status, 401); assert.equal(early.body.error.code, 'INVALID_CREDENTIALS');

  // public check of the link
  const c = await checkInvite(token);
  assert.equal(c.status, 200);
  assert.deepEqual(c.body, { email: 'editor@example.org', name: 'Priya', role: 'content_editor' });

  // password rules: 12+ characters
  const short = await accept(token, 'short-pass1');
  assert.equal(short.status, 400); assert.equal(short.body.error.code, 'VALIDATION_ERROR');
  const ok = await accept(token, PASSWORD);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.token, undefined);                       // no admin token: they log in normally
  // the link works once
  assert.equal((await checkInvite(token)).body.error.code, 'INVITE_INVALID');
  assert.equal((await accept(token, PASSWORD)).status, 404);

  const after = (await h.query('SELECT * FROM admins WHERE id = ?', [ad.id]))[0];
  assert.equal(after.invite_token_hash, null);
  assert.ok(after.password_hash.startsWith('$2'));            // bcrypt, like every other admin password
  const me = await h.adminLogin({ email: 'editor@example.org', password: PASSWORD });
  assert.equal(me.admin.role, 'content_editor');
  const l = await listed(b.auth, 'editor@example.org');
  assert.equal(l.status, 'active'); assert.equal(l.inviteExpiresAt, null); assert.ok(l.activatedAt);

  const log = await h.query('SELECT * FROM audit_log');
  const acts = log.map((x) => x.action);
  assert.ok(acts.includes('admin.invited') && acts.includes('admin.invite_accepted'));
  const accepted = log.find((x) => x.action === 'admin.invite_accepted');
  assert.equal(accepted.admin_email, 'editor@example.org');
  const text = JSON.stringify(log);
  assert.ok(!text.includes(token) && !text.includes(PASSWORD), 'no token or password in the audit log');
});

test('only Full Admins invite; an email already used by an admin (active or invited) is 409 ADMIN_EXISTS', async () => {
  const b = await boss();
  const ed = await h.makeAdmin('ed@example.org', 'content_editor'); const e = await h.adminLogin(ed);
  assert.equal((await invite(bearer(e.token), { email: 'x@example.org', name: 'X', role: 'content_editor' })).status, 403);
  assert.equal((await api().post('/api/v1/admin/admins').send({ email: 'x@example.org', name: 'X', role: 'content_editor' })).status, 401);
  const taken = await invite(b.auth, { email: 'ED@example.org', name: 'Ed', role: 'full_admin' });
  assert.equal(taken.status, 409); assert.equal(taken.body.error.code, 'ADMIN_EXISTS');
  assert.equal((await invite(b.auth, { email: 'new@example.org', name: 'New', role: 'full_admin' })).status, 201);
  assert.equal((await invite(b.auth, { email: 'new@example.org', name: 'New', role: 'full_admin' })).body.error.code, 'ADMIN_EXISTS');
  assert.equal((await invite(b.auth, { email: 'y@example.org', name: 'Y', role: 'owner' })).status, 400);
});

test('expired and unknown invite links', async () => {
  const b = await boss();
  await invite(b.auth, { email: 'new@example.org', name: 'New', role: 'content_editor' });
  const token = tokenOf(lastInvite('new@example.org'));
  await h.query("UPDATE admins SET invite_expires_at = UTC_TIMESTAMP() - INTERVAL 1 SECOND WHERE email = 'new@example.org'");
  const c = await checkInvite(token);
  assert.equal(c.status, 410); assert.equal(c.body.error.code, 'INVITE_EXPIRED');
  const a = await accept(token, PASSWORD);
  assert.equal(a.status, 410); assert.equal(a.body.error.code, 'INVITE_EXPIRED');
  assert.equal((await listed(b.auth, 'new@example.org')).status, 'invited');
  const bad = await checkInvite('not-a-real-token');
  assert.equal(bad.status, 404); assert.equal(bad.body.error.code, 'INVITE_INVALID');
  assert.equal((await accept('not-a-real-token', PASSWORD)).body.error.code, 'INVITE_INVALID');
});

test('resend invite: new link, old one stops working; only for invited admins', async () => {
  const b = await boss();
  const id = (await invite(b.auth, { email: 'new@example.org', name: 'New', role: 'content_editor' })).body.admin.id;
  const oldToken = tokenOf(lastInvite('new@example.org'));
  await h.query("UPDATE admins SET invite_expires_at = UTC_TIMESTAMP() - INTERVAL 1 HOUR WHERE id = ?", [id]);   // even an expired one can be resent
  const r = await api().post(`/api/v1/admin/admins/${id}/resend-invite`).set(b.auth);
  assert.equal(r.status, 200);
  assert.equal(r.body.admin.status, 'invited');
  assert.ok(new Date(r.body.admin.inviteExpiresAt) - Date.now() > 47.9 * 3600000);
  const newToken = tokenOf(lastInvite('new@example.org'));
  assert.notEqual(newToken, oldToken);
  assert.ok(!JSON.stringify(r.body).includes(newToken));
  assert.equal((await checkInvite(oldToken)).body.error.code, 'INVITE_INVALID');
  assert.equal((await accept(newToken, PASSWORD)).status, 200);
  const again = await api().post(`/api/v1/admin/admins/${id}/resend-invite`).set(b.auth);
  assert.equal(again.status, 409); assert.equal(again.body.error.code, 'ADMIN_NOT_INVITED');
  assert.equal((await api().post('/api/v1/admin/admins/999999/resend-invite').set(b.auth)).status, 404);
  assert.ok((await actions()).includes('admin.invite_resent'));
});

test('cancel invite: DELETE removes an invited admin; active admins cannot be deleted this way', async () => {
  const b = await boss();
  const id = (await invite(b.auth, { email: 'new@example.org', name: 'New', role: 'content_editor' })).body.admin.id;
  const token = tokenOf(lastInvite('new@example.org'));
  const d = await api().delete(`/api/v1/admin/admins/${id}`).set(b.auth);
  assert.equal(d.status, 200); assert.equal(d.body.cancelled, true);
  assert.equal((await h.query('SELECT COUNT(*) AS n FROM admins WHERE id = ?', [id]))[0].n, 0);
  assert.equal((await checkInvite(token)).body.error.code, 'INVITE_INVALID');
  assert.equal((await api().delete(`/api/v1/admin/admins/${id}`).set(b.auth)).status, 404);
  const ed = await h.makeAdmin('ed@example.org', 'content_editor');
  const notInvited = await api().delete(`/api/v1/admin/admins/${ed.id}`).set(b.auth);
  assert.equal(notInvited.status, 409); assert.equal(notInvited.body.error.code, 'ADMIN_NOT_INVITED');
  assert.ok((await actions()).includes('admin.invite_cancelled'));
  // the address can be invited again afterwards
  assert.equal((await invite(b.auth, { email: 'new@example.org', name: 'New', role: 'content_editor' })).status, 201);
});

test('role change, deactivate and reactivate: audited; deactivated admins cannot log in and their tokens stop', async () => {
  const b = await boss();
  const ed = await h.makeAdmin('ed@example.org', 'content_editor'); const e = await h.adminLogin(ed);
  const url = `/api/v1/admin/admins/${ed.id}`;

  const promote = await api().patch(url).set(b.auth).send({ role: 'full_admin' });
  assert.equal(promote.status, 200); assert.equal(promote.body.admin.role, 'full_admin');
  assert.equal((await api().get('/api/v1/admin/auth/me').set(bearer(e.token))).status, 401);   // role change ends sessions
  const e2 = await h.adminLogin(ed);

  const off = await api().patch(url).set(b.auth).send({ active: false });
  assert.equal(off.status, 200); assert.equal(off.body.admin.status, 'inactive');
  assert.equal((await api().get('/api/v1/admin/auth/me').set(bearer(e2.token))).status, 401);
  const login = await api().post('/api/v1/admin/auth/login').send({ email: ed.email, password: ed.password });
  assert.equal(login.status, 401); assert.equal(login.body.error.code, 'INVALID_CREDENTIALS');

  const on = await api().patch(url).set(b.auth).send({ active: true });
  assert.equal(on.status, 200); assert.equal(on.body.admin.status, 'active');
  assert.ok((await h.adminLogin(ed)).token);
  // the older field name still works
  assert.equal((await api().patch(url).set(b.auth).send({ isActive: false })).body.admin.status, 'inactive');

  const log = await h.query("SELECT action, details FROM audit_log WHERE entity_type = 'admin' AND action IN ('admin.role_changed', 'admin.deactivated', 'admin.reactivated') ORDER BY id");
  assert.deepEqual(log.map((x) => x.action), ['admin.role_changed', 'admin.deactivated', 'admin.reactivated', 'admin.deactivated']);
  assert.deepEqual(log[0].details, { from: 'content_editor', to: 'full_admin' });
});

test('you cannot deactivate or demote yourself, and at least one active Full Admin always remains', async () => {
  const b = await boss();
  const me = `/api/v1/admin/admins/${b.id}`;
  // the only Full Admin
  const last = await api().patch(me).set(b.auth).send({ role: 'content_editor' });
  assert.equal(last.status, 409); assert.equal(last.body.error.code, 'LAST_FULL_ADMIN');
  assert.equal((await api().patch(me).set(b.auth).send({ active: false })).body.error.code, 'LAST_FULL_ADMIN');
  // with a second Full Admin it is still refused for yourself
  const second = await h.makeAdmin('second@example.org');
  assert.equal((await api().patch(me).set(b.auth).send({ role: 'content_editor' })).body.error.code, 'CANNOT_DEMOTE_SELF');
  assert.equal((await api().patch(me).set(b.auth).send({ active: false })).body.error.code, 'CANNOT_DEACTIVATE_SELF');
  // renaming yourself is fine; another Full Admin can be demoted
  assert.equal((await api().patch(me).set(b.auth).send({ name: 'The Boss' })).body.admin.name, 'The Boss');
  assert.equal((await api().patch(`/api/v1/admin/admins/${second.id}`).set(b.auth).send({ role: 'content_editor' })).status, 200);
  // an invited Full Admin does not count as active
  await invite(b.auth, { email: 'inv@example.org', name: 'Inv', role: 'full_admin' });
  assert.equal((await api().patch(me).set(b.auth).send({ role: 'content_editor' })).body.error.code, 'LAST_FULL_ADMIN');
  assert.equal((await h.query("SELECT role FROM admins WHERE id = ?", [b.id]))[0].role, 'full_admin');
});

test('an invited admin is activated only by accepting; role can be changed before that; reset-password is refused', async () => {
  const b = await boss();
  const id = (await invite(b.auth, { email: 'new@example.org', name: 'New', role: 'content_editor' })).body.admin.id;
  const url = `/api/v1/admin/admins/${id}`;
  const act = await api().patch(url).set(b.auth).send({ active: true });
  assert.equal(act.status, 409); assert.equal(act.body.error.code, 'ADMIN_INVITED');
  assert.equal((await api().post(`${url}/reset-password`).set(b.auth).send({ newPassword: 'SomePassword123' })).body.error.code, 'ADMIN_INVITED');
  assert.equal((await api().patch(url).set(b.auth).send({ role: 'full_admin' })).body.admin.role, 'full_admin');
  const c = await checkInvite(tokenOf(lastInvite('new@example.org')));
  assert.equal(c.body.role, 'full_admin');
});

test('if the invite email cannot be sent: 503 and no admin is created', async () => {
  const b = await boss();
  const real = mailer.sendAdminInvite;
  mailer.sendAdminInvite = async () => { throw new Error('SMTP down'); };
  const errLog = console.error; console.error = () => {};
  try {
    const r = await invite(b.auth, { email: 'new@example.org', name: 'New', role: 'content_editor' });
    assert.equal(r.status, 503); assert.equal(r.body.error.code, 'EMAIL_FAILED');
  } finally { mailer.sendAdminInvite = real; console.error = errLog; }
  assert.equal((await h.query("SELECT COUNT(*) AS n FROM admins WHERE email = 'new@example.org'"))[0].n, 0);
  assert.ok(!(await actions()).includes('admin.invited'));
});

test('npm run seed:admin still creates an active Full Admin who can log in', async () => {
  const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'seed-admin.js'), 'first@example.org', 'FirstPassphrase12', 'First'],
    { env: { ...process.env, NODE_ENV: 'test' }, encoding: 'utf8' });
  assert.match(out, /Created Full Admin first@example\.org/);
  const t = await h.adminLogin({ email: 'first@example.org', password: 'FirstPassphrase12' });
  assert.equal(t.admin.role, 'full_admin');
  assert.equal((await listed(bearer(t.token), 'first@example.org')).status, 'active');
});
