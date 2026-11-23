// Writes every email's HTML (and plain text) to tmp/email-previews/ with sample data, to open in a browser.
//   npm run preview:emails
// Never sends anything: the mail transport is forced to "console" before the config loads.
process.env.MAIL_TRANSPORT = 'console';
const fs = require('fs');
const path = require('path');
const mailer = require('../src/utils/mailer');

const OUT = path.join(__dirname, '..', 'tmp', 'email-previews');
const TO = 'preview@example.org';
const samples = [
  ['verification-code', () => mailer.sendVerificationCode(TO, '482913')],
  ['password-reset-code', () => mailer.sendPasswordResetCode(TO, '730516')],
  ['account-deleted', () => mailer.sendAccountDeletedEmail(TO)],
  ['admin-login-code', () => mailer.sendAdminLoginCode(TO, '205871')],
  ['admin-invite', () => mailer.sendAdminInvite(TO, { name: 'Priya', invitedBy: 'Abhinav', role: 'content_editor', link: 'http://localhost:5173/accept-invite?token=sample-token' })],
  ['admin-login-alert', () => mailer.sendAdminLoginAlert(TO, { name: 'Priya', email: 'priya@example.org', role: 'content_editor', at: new Date(), device: 'Chrome on Windows' })],
];

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const log = console.log;
  console.log = () => {};   // the console transport prints every email; the files are enough here
  const written = [];
  try {
    for (const [name, send] of samples) {
      await send();
      const m = mailer.outbox[mailer.outbox.length - 1];
      fs.writeFileSync(path.join(OUT, `${name}.html`), m.html);
      fs.writeFileSync(path.join(OUT, `${name}.txt`), `Subject: ${m.subject}\n\n${m.text}`);
      written.push(`${name}.html  (${m.subject})`);
    }
  } finally {
    console.log = log;
  }
  console.log(`Wrote ${written.length} email previews to ${OUT}\n  ${written.join('\n  ')}`);
  console.log(`The logo loads from ${mailer.logoUrl()} (start the API with npm run dev to see it).`);
}
main().catch((e) => { console.error(e); process.exit(1); });
