process.env.NODE_ENV = 'test';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const mailer = require('../src/utils/mailer');

beforeEach(() => { mailer.outbox.length = 0; });

const LOGO = 'http://localhost:3000/static/email-logo.png';
const BRAND = (html) => {
  assert.match(html, /^<!doctype html>/);
  assert.ok(html.includes(`<img src="${LOGO}"`), 'logo at the top, absolute URL');
  assert.ok(!/src="data:/.test(html), 'no base64 images');
  assert.ok(html.indexOf('<img') < html.indexOf('<h1'), 'logo before the title');
  assert.ok(html.includes('max-width:480px'), '480px column');
  assert.ok(html.includes('font-family:Inter,Arial'), 'Inter / Arial');
  assert.ok(html.includes('text-align:center'), 'centred');
  assert.ok(html.includes('name="viewport"'), 'mobile viewport');
};
const last = () => mailer.outbox[mailer.outbox.length - 1];

test('the logo URL is PUBLIC_BASE_URL + /static/email-logo.png (default http://localhost:3000)', () => {
  assert.equal(config.publicBaseUrl, 'http://localhost:3000');
  assert.equal(mailer.logoUrl(), LOGO);
  const saved = config.publicBaseUrl;
  config.publicBaseUrl = 'https://api.satsangspark.org';
  try {
    assert.equal(mailer.logoUrl(), 'https://api.satsangspark.org/static/email-logo.png');
    assert.ok(mailer.brandedHtml({ title: 'x' }).includes('<img src="https://api.satsangspark.org/static/email-logo.png"'));
  } finally { config.publicBaseUrl = saved; }
});

test('verification email: the client\'s exact subject and content, 15 minutes, code easy to extract', async () => {
  await mailer.sendVerificationCode('a@example.org', '482913');
  const m = last();
  assert.equal(m.subject, '482913 is your Satsang Spark verification code');
  assert.equal(m.text, `Your Satsang Spark verification code is 482913.

🙏 Welcome to Satsang Spark!

We're excited to have you join us!

✨ YOUR VERIFICATION CODE:
482913

⏳ This code expires in 15 minutes.
🔒 Please do not share this code with anyone.

If you didn't request this code, you can safely ignore this email.

— Team Satsang Spark
`);
  assert.equal(m.text.match(/CODE:\n(\d{6})\n/)[1], '482913');
  BRAND(m.html);
  const h = m.html;
  assert.match(h, /<h1 style="[^"]*font-size:26px[^"]*font-weight:bold[^"]*">🙏 Welcome to Satsang Spark!<\/h1>/);
  assert.match(h, /<p style="[^"]*">We&#39;re excited to have you join us!<\/p>/);
  assert.match(h, /<p style="[^"]*font-variant:small-caps[^"]*">✨ YOUR VERIFICATION CODE:<\/p>/);
  const codeP = h.match(/<p style="([^"]*)">482913<\/p>/);
  assert.ok(codeP, 'code in its own box');
  assert.match(codeP[1], /font-size:3[6-9]px|font-size:40px/);
  assert.match(codeP[1], /font-weight:bold/);
  assert.match(codeP[1], /letter-spacing:\d+px/);
  assert.match(codeP[1], /background:#/);
  assert.match(h, />⏳ This code expires in 15 minutes\.<\/p>/);
  assert.match(h, />🔒 Please do not share this code with anyone\.<\/p>/);
  assert.match(h, /<p style="[^"]*font-size:13px[^"]*color:#8a8279">If you didn&#39;t request this code, you can safely ignore this email\.<\/p>/);
  assert.match(h, />— Team Satsang Spark<\/p>/);
  // order as the client wrote it
  const order = ['Welcome to Satsang Spark!', 'excited', 'YOUR VERIFICATION CODE', '482913', 'expires in 15', 'do not share', 'safely ignore', 'Team Satsang Spark'];
  const at = order.map((s) => h.indexOf(s));
  assert.deepEqual([...at].sort((a, b) => a - b), at);
  assert.equal(mailer.CODE_MINUTES, 15);
  assert.equal(require('../src/utils/emailCodes').CODE_MINUTES, 15);
});

test('account deleted email: the client\'s exact subject and content', async () => {
  await mailer.sendAccountDeletedEmail('a@example.org');
  const m = last();
  assert.equal(m.subject, '🙏 Satsang Spark – Account Deletion Confirmation');
  assert.equal(m.text, `Hello,

Your Satsang Spark account has been successfully deleted.

All data associated with your account has been permanently deleted, and you have been logged out of all devices.

We're grateful you were part of the Satsang Spark community. Thank you for being with us! 💛

Wishing you all the best.

— Team Satsang Spark
`);
  BRAND(m.html);
  for (const line of ['Hello,', 'Your Satsang Spark account has been successfully deleted.',
    'All data associated with your account has been permanently deleted, and you have been logged out of all devices.',
    'We&#39;re grateful you were part of the Satsang Spark community. Thank you for being with us! 💛',
    'Wishing you all the best.', '— Team Satsang Spark']) assert.ok(m.html.includes(`>${line}</p>`), line);
});

test('every email is sent as plain text + the shared branded layout with the logo', async () => {
  const at = new Date('2026-11-23T15:04:05Z');
  const sends = [
    ['123456 is your Satsang Spark verification code', () => mailer.sendVerificationCode('a@example.org', '123456'), ['123456']],
    ['654321 is your Satsang Spark password reset code', () => mailer.sendPasswordResetCode('a@example.org', '654321'), ['654321', 'This code expires in 15 minutes.']],
    ['🙏 Satsang Spark – Account Deletion Confirmation', () => mailer.sendAccountDeletedEmail('a@example.org'), ['successfully deleted']],
    ['111222 is your Satsang Spark admin login code', () => mailer.sendAdminLoginCode('a@example.org', '111222'), ['111222', 'It expires in 10 minutes.']],
    ["You've been invited to the Satsang Spark Admin Panel",
      () => mailer.sendAdminInvite('a@example.org', { name: 'Priya', invitedBy: 'boss', role: 'content_editor', link: 'http://localhost:5173/accept-invite?token=abc_DEF-123' }),
      ['Hello Priya,', 'as Content Editor.', 'href="http://localhost:5173/accept-invite?token=abc_DEF-123"', 'Choose your password']],
    ['Satsang Spark Admin – new sign-in',
      () => mailer.sendAdminLoginAlert('a@example.org', { name: 'Meera', email: 'm@example.org', role: 'full_admin', at, device: 'Chrome on Windows' }),
      ['Meera (m@example.org), Full Admin', '20:34:05 IST', '15:04:05 UTC', 'Chrome on Windows']],
  ];
  for (const [subject, send, expected] of sends) {
    await send();
    const m = last();
    assert.equal(m.subject, subject);
    assert.ok(m.text && !m.text.includes('<'), `${subject}: plain text part`);
    BRAND(m.html);
    for (const e of expected) assert.ok(m.html.includes(e), `${subject}: html has ${e}`);
  }
  // the reset code is extractable the same way as the verification code
  await mailer.sendPasswordResetCode('a@example.org', '654321');
  assert.equal(last().text.match(/CODE:\n(\d{6})\n/)[1], '654321');
});

test('code emails are Gmail "Copy code" friendly: code-first subject, clear first text line, plain digits, one HTML element', async () => {
  const cases = [
    [() => mailer.sendVerificationCode('a@example.org', '602032'), 'verification code'],
    [() => mailer.sendPasswordResetCode('a@example.org', '602032'), 'password reset code'],
    [() => mailer.sendAdminLoginCode('a@example.org', '602032'), 'admin login code'],
  ];
  for (const [send, what] of cases) {
    await send();
    const m = last();
    assert.equal(m.subject, `602032 is your Satsang Spark ${what}`);
    assert.equal(m.text.split('\n')[0].replace(/ It expires.*$/, ''), `Your Satsang Spark ${what} is 602032.`);
    assert.ok(!/6\s+0\s*2|0\s+3\s*2/.test(m.text), `${what}: digits not spaced in text`);
    const box = m.html.match(/<p style="([^"]*)">602032<\/p>/);
    assert.ok(box, `${what}: code is one text element in the HTML`);
    assert.match(box[1], /letter-spacing:\d+px/);
    assert.equal(m.html.split('602032').length - 1, 1, `${what}: code appears once in the HTML, not split`);
  }
});

test('an email sent without its own HTML still gets the layout (subject as title, text paragraphs, escaped)', async () => {
  await mailer.sendMail({ to: 'a@example.org', subject: 'Hello <there>', text: 'First paragraph.\n\nSecond & last.' });
  const m = last();
  BRAND(m.html);
  assert.ok(m.html.includes('>Hello &lt;there&gt;</h1>'));
  assert.ok(m.html.includes('>First paragraph.</p>'));
  assert.ok(m.html.includes('>Second &amp; last.</p>'));
});

test('layout escapes every value', () => {
  const html = mailer.brandedHtml({ title: '<b>', blocks: [{ p: '"x"' }, { rows: [['k', '<v>']] }, { code: '<1>' }, { small: '<s>' }, { label: '<l>' }, { button: { label: '<go>', href: 'https://e.org/?a="b"' } }, { sign: '<t>' }] });
  assert.ok(!/<b>|<v>|<1>|<go>|<s>|<l>|<t>|"b"/.test(html));
});
