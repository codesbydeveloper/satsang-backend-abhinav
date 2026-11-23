process.env.NODE_ENV = 'test';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mailer = require('../src/utils/mailer');

beforeEach(() => { mailer.outbox.length = 0; });

const BRAND = (html) => {
  assert.match(html, /^<!doctype html>/);
  assert.ok(html.includes('background:#e8742a'), 'header bar');
  assert.ok(html.includes('Satsang Spark · Loyadham'), 'footer');
};
const last = () => mailer.outbox[mailer.outbox.length - 1];

test('every email is sent as plain text + the shared branded layout', async () => {
  const at = new Date('2026-11-23T15:04:05Z');
  const sends = [
    ['Verify your Satsang Spark email', () => mailer.sendVerificationCode('a@example.org', '123456'), ['123456', 'Welcome to Satsang Spark!']],
    ['Reset your Satsang Spark password', () => mailer.sendPasswordResetCode('a@example.org', '654321'), ['654321', 'This code expires in 15 minutes.']],
    ['Your Satsang Spark account has been deleted', () => mailer.sendAccountDeletedEmail('a@example.org'), ['Your account has been successfully removed.']],
    ['Your Satsang Spark admin login code', () => mailer.sendAdminLoginCode('a@example.org', '111222'), ['111222', 'It expires in 10 minutes.']],
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
  const html = mailer.brandedHtml({ title: '<b>', lines: ['"x"'], rows: [['k', '<v>']], code: '<1>', button: { label: '<go>', href: 'https://e.org/?a="b"' } });
  assert.ok(!/<b>|<v>|<1>|<go>|"b"/.test(html));
});
