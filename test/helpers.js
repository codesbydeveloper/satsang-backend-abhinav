process.env.NODE_ENV = 'test';
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { createApp } = require('../src/app');
const { query, pool } = require('../src/db');
const { outbox } = require('../src/utils/mailer');

const app = createApp();
const api = () => request(app);

async function resetDb() {
  // tests TRUNCATE tables — never allow them to run against a real database
  if (!/_test$/.test(require('../src/config').db.database)) throw new Error('Refusing to run tests: DB_NAME in .env.test must end with _test');
  await query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of ['profile_sparks_rewards', 'referrals', 'explore_import_items', 'explore_imports', 'account_deletion_requests', 'audit_log', 'admin_login_codes', 'profile_activity_minutes', 'profile_daily_activity', 'refresh_tokens', 'email_codes', 'signup_bonuses', 'profiles', 'accounts', 'admins']) await query(`TRUNCATE TABLE ${t}`);
  await query('SET FOREIGN_KEY_CHECKS = 1');
  await query("UPDATE app_settings SET value = CASE setting_key WHEN 'referral_new_user_sparks' THEN '25' WHEN 'referral_referrer_sparks' THEN '50' WHEN 'referral_window_hours' THEN '48' ELSE NULL END, updated_by = NULL");
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
    email, password: 'Secret123', accountType: 'adult', acceptPrivacyPolicy: true, ...NAMES,
    profile: { username, avatarId: 3, dob: dobYearsAgo(30), mode: 'satsang' }, ...extra });
  if (reg.status !== 201) throw new Error('register failed: ' + JSON.stringify(reg.body));
  const v = await api().post('/api/v1/auth/verify-email').send({ email, code: lastCode(email) });
  if (v.status !== 200) throw new Error('verify failed: ' + JSON.stringify(v.body));
  return v.body;
}

/** Register + verify a parent, set PIN 1234. */
async function parentLogin(email = 'parent@example.org') {
  const reg = await api().post('/api/v1/auth/register').send({ email, password: 'Secret123', accountType: 'parent', acceptPrivacyPolicy: true, confirmAdult: true, ...NAMES });
  if (reg.status !== 201) throw new Error('register failed: ' + JSON.stringify(reg.body));
  const v = await api().post('/api/v1/auth/verify-email').send({ email, code: lastCode(email) });
  const auth = { Authorization: `Bearer ${v.body.accessToken}` };
  const pin = await api().post('/api/v1/parent/pin').set(auth).send({ pin: '1234', password: 'Secret123' });
  if (pin.status !== 201) throw new Error('pin failed: ' + JSON.stringify(pin.body));
  return { ...v.body, auth };
}

/** The private Sign Up details every register now sends (both account types). */
const NAMES = { firstName: 'Ravi', lastName: 'Kumar', gender: 'male' };

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

async function makeAdmin(email, role = 'full_admin', password = 'AdminPassphrase1!') {
  const r = await query('INSERT INTO admins (email, name, password_hash, role) VALUES (?,?,?,?)', [email, email.split('@')[0], await bcrypt.hash(password, 4), role]);
  return { id: r.insertId, email, password };
}

/** The 6-digit admin login code in the latest email to `to`. */
const lastAdminCode = (to) => {
  const m = [...outbox].reverse().find((x) => x.to === to && x.subject === 'Your Satsang Spark admin login code');
  return m && m.text.match(/Your login code is (\d{6})\./)[1];
};

/** Full admin login: password, then the emailed code. Returns { token, admin }. */
async function adminLogin(admin) {
  const l = await api().post('/api/v1/admin/auth/login').send({ email: admin.email, password: admin.password });
  if (l.status !== 200) throw new Error('admin login failed: ' + JSON.stringify(l.body));
  const v = await api().post('/api/v1/admin/auth/verify-otp').send({ challengeToken: l.body.challengeToken, code: lastAdminCode(admin.email) });
  if (v.status !== 200) throw new Error('verify-otp failed: ' + JSON.stringify(v.body));
  return { token: v.body.token, admin: v.body.admin };
}

module.exports = { NAMES, api, resetDb, lastCode, dobYearsAgo, adultLogin, parentLogin, bearer, makeAdmin, adminLogin, lastAdminCode, query, pool, outbox };
