process.env.NODE_ENV = 'test';
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const { createApp } = require('../src/app');
const { query, pool } = require('../src/db');
const { outbox } = require('../src/utils/mailer');

const app = createApp();
const api = () => request(app);

async function resetDb() {
  // tests TRUNCATE tables — never allow them to run against a real database
  if (!/_test$/.test(require('../src/config').db.database)) throw new Error('Refusing to run tests: DB_NAME in .env.test must end with _test');
  await query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of ['audit_log', 'profile_daily_activity', 'refresh_tokens', 'email_codes', 'profiles', 'accounts', 'admins']) await query(`TRUNCATE TABLE ${t}`);
  await query('SET FOREIGN_KEY_CHECKS = 1');
  outbox.length = 0;
}

const lastCode = (to) => {
  const m = [...outbox].reverse().find((x) => x.to === to);
  return m && m.text.match(/Your code: (\d{6})/)[1];
};

const dobYearsAgo = (years, extraDays = 0) => {
  const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - years); d.setUTCDate(d.getUTCDate() - extraDays);
  return d.toISOString().slice(0, 10);
};

/** Register + verify an adult account; returns the AuthResponse body. */
async function adultLogin(email = 'ravi@example.org', username = 'ravi_k', extra = {}) {
  const reg = await api().post('/api/v1/auth/register').send({
    email, password: 'Secret123', accountType: 'adult', acceptPrivacyPolicy: true,
    profile: { username, avatarId: 3, dob: dobYearsAgo(30), mode: 'satsang' }, ...extra });
  if (reg.status !== 201) throw new Error('register failed: ' + JSON.stringify(reg.body));
  const v = await api().post('/api/v1/auth/verify-email').send({ email, code: lastCode(email) });
  if (v.status !== 200) throw new Error('verify failed: ' + JSON.stringify(v.body));
  return v.body;
}

/** Register + verify a parent, set PIN 1234. */
async function parentLogin(email = 'parent@example.org') {
  const reg = await api().post('/api/v1/auth/register').send({ email, password: 'Secret123', accountType: 'parent', acceptPrivacyPolicy: true, confirmAdult: true });
  if (reg.status !== 201) throw new Error('register failed: ' + JSON.stringify(reg.body));
  const v = await api().post('/api/v1/auth/verify-email').send({ email, code: lastCode(email) });
  const auth = { Authorization: `Bearer ${v.body.accessToken}` };
  const pin = await api().post('/api/v1/parent/pin').set(auth).send({ pin: '1234', password: 'Secret123' });
  if (pin.status !== 201) throw new Error('pin failed: ' + JSON.stringify(pin.body));
  return { ...v.body, auth };
}

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

async function makeAdmin(email, role = 'full_admin', password = 'AdminPassphrase1!') {
  const r = await query('INSERT INTO admins (email, name, password_hash, role) VALUES (?,?,?,?)', [email, email.split('@')[0], await bcrypt.hash(password, 4), role]);
  return { id: r.insertId, email, password };
}

/** Full admin login incl. first-time 2FA enrolment; returns { token, secret }. */
async function adminLogin(admin, secretIfKnown) {
  const l = await api().post('/api/v1/admin/auth/login').send({ email: admin.email, password: admin.password });
  if (l.status !== 200) throw new Error('admin login failed: ' + JSON.stringify(l.body));
  if (l.body.step === 'totp_setup') {
    const s = await api().post('/api/v1/admin/auth/totp/setup').set(bearer(l.body.stepToken));
    const e = await api().post('/api/v1/admin/auth/totp/enable').set(bearer(l.body.stepToken)).send({ code: authenticator.generate(s.body.secret) });
    if (e.status !== 200) throw new Error('enable failed: ' + JSON.stringify(e.body));
    return { token: e.body.token, secret: s.body.secret };
  }
  const v = await api().post('/api/v1/admin/auth/totp/verify').set(bearer(l.body.stepToken)).send({ code: authenticator.generate(secretIfKnown) });
  if (v.status !== 200) throw new Error('verify failed: ' + JSON.stringify(v.body));
  return { token: v.body.token, secret: secretIfKnown };
}

module.exports = { api, resetDb, lastCode, dobYearsAgo, adultLogin, parentLogin, bearer, makeAdmin, adminLogin, query, pool, outbox };
