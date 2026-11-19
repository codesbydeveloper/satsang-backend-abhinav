const nodemailer = require('nodemailer');
const config = require('../config');

let transporter = null;
const outbox = []; // last messages in console/test mode (used by tests)

function getTransport() {
  if (transporter) return transporter;
  transporter = config.mail.transport === 'smtp'
    ? nodemailer.createTransport({
        host: config.mail.host, port: config.mail.port, secure: config.mail.secure,
        auth: config.mail.user ? { user: config.mail.user, pass: config.mail.pass } : undefined,
      })
    : null;
  return transporter;
}

async function sendMail({ to, subject, text, html }) {
  const t = getTransport();
  if (!t) {
    outbox.push({ to, subject, text, html });
    if (outbox.length > 50) outbox.shift();
    if (config.env !== 'test') console.log(`[mail:console] to=${to} subject="${subject}"\n${text}\n`);
    return;
  }
  await t.sendMail({ from: config.mail.from, to, subject, text, ...(html ? { html } : {}) });
}

const codeText = (intro, code) =>
  `${intro}\n\nYour code: ${code}\n\nThis code expires in 15 minutes. If you did not request it, you can ignore this email.`;

const sendVerificationCode = (to, code) =>
  sendMail({ to, subject: 'Verify your Satsang Spark email', text: codeText('Welcome to Satsang Spark!', code) });
const sendPasswordResetCode = (to, code) =>
  sendMail({ to, subject: 'Reset your Satsang Spark password', text: codeText('We received a request to reset your password.', code) });

const DELETED_BODY = 'Your account has been successfully removed. Everything linked to it has been deleted and you have been logged out on every device. Thank you for being part of Satsang Spark.';
/** Sent when an account deletion completes. Greeting + fixed text only: no other personal data. */
const sendAccountDeletedEmail = (to) => sendMail({
  to,
  subject: 'Your Satsang Spark account has been deleted',
  text: `Hello,

${DELETED_BODY}
`,
  html: `<p>Hello,</p><p>${DELETED_BODY}</p>`,
});

const mailer = { sendMail, sendVerificationCode, sendPasswordResetCode, sendAccountDeletedEmail, outbox };
module.exports = mailer;
