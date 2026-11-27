const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('./helpers');
const { api } = h;

beforeEach(h.resetDb);
after(() => h.pool.end());

const register = (email) => api().post('/api/v1/auth/register').send({
  email, password: 'Secret123', accountType: 'adult', acceptPrivacyPolicy: true, ...h.NAMES,
  profile: { username: 'ravi_k', avatarId: 3, dob: h.dobYearsAgo(30), mode: 'satsang' } });
const minutesLeft = (row) => (new Date(String(row.expires_at).replace(' ', 'T') + 'Z') - Date.now()) / 60000;

test('verification codes are stored to expire 15 minutes after sending, and stop working then', async () => {
  const email = 'ravi@example.org';
  assert.equal((await register(email)).status, 201);
  const mail = h.outbox.find((m) => m.to === email);
  assert.ok(mail.text.includes('⏳ This code expires in 15 minutes.'));
  const code = h.lastCode(email);
  assert.equal(mail.subject, `${code} is your Satsang Spark verification code`);
  assert.ok(mail.text.startsWith(`Your Satsang Spark verification code is ${code}.\n`));
  assert.match(code, /^\d{6}$/);

  const row = (await h.query("SELECT * FROM email_codes WHERE purpose = 'verify_email' ORDER BY id DESC LIMIT 1"))[0];
  const left = minutesLeft(row);
  assert.ok(left > 14.9 && left <= 15, String(left));

  // 15 minutes later (expires_at reached) the correct code is refused
  await h.query('UPDATE email_codes SET expires_at = UTC_TIMESTAMP() - INTERVAL 1 SECOND WHERE id = ?', [row.id]);
  const late = await api().post('/api/v1/auth/verify-email').send({ email, code });
  assert.equal(late.status, 400);
  assert.equal(late.body.error.code, 'CODE_INVALID');

  // a fresh code works (just before its 15 minutes are up)
  assert.equal((await api().post('/api/v1/auth/resend-code').send({ email })).status, 200);
  const code2 = h.lastCode(email);
  await h.query("UPDATE email_codes SET expires_at = UTC_TIMESTAMP() + INTERVAL 5 SECOND WHERE purpose = 'verify_email' AND consumed_at IS NULL");
  assert.equal((await api().post('/api/v1/auth/verify-email').send({ email, code: code2 })).status, 200);
});

test('password reset codes also expire after 15 minutes', async () => {
  const email = 'ravi@example.org';
  await h.adultLogin(email, 'ravi_k');
  assert.equal((await api().post('/api/v1/auth/forgot-password').send({ email })).status, 200);
  const mail = [...h.outbox].reverse().find((m) => m.to === email);
  const code = mail.text.match(/CODE:\n(\d{6})\n/)[1];
  assert.equal(mail.subject, `${code} is your Satsang Spark password reset code`);
  assert.ok(mail.text.startsWith(`Your Satsang Spark password reset code is ${code}.\n`));
  const row = (await h.query("SELECT * FROM email_codes WHERE purpose <> 'verify_email' ORDER BY id DESC LIMIT 1"))[0];
  const left = minutesLeft(row);
  assert.ok(left > 14.9 && left <= 15, String(left));
});

test('the email logo is served at /static/email-logo.png (PNG, ≤ 480 px wide, compressed, loadable cross-origin)', async () => {
  const r = await api().get('/static/email-logo.png').buffer(true).parse((res, cb) => {
    const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /^image\/png/);
  assert.equal(r.headers['cross-origin-resource-policy'], 'cross-origin');
  assert.match(r.headers['cache-control'], /max-age=\d+/);
  const png = r.body;
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  assert.ok(width <= 480 && width >= 240, `width ${width}`);
  assert.equal(width / height, 2);   // same 2:1 shape as the official logo
  assert.ok(png.length < 80 * 1024, `${png.length} bytes`);
  assert.deepEqual(png, fs.readFileSync(path.join(__dirname, '..', 'public', 'static', 'email-logo.png')));
  // nothing else is exposed
  assert.equal((await api().get('/static/')).status, 404);
  assert.equal((await api().get('/static/../package.json')).status, 404);
});
