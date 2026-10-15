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

async function sendMail({ to, subject, text }) {
  const t = getTransport();
  if (!t) {
    outbox.push({ to, subject, text });
    if (outbox.length > 50) outbox.shift();
    if (config.env !== 'test') console.log(`[mail:console] to=${to} subject="${subject}"\n${text}\n`);
    return;
  }
  await t.sendMail({ from: config.mail.from, to, subject, text });
}

const codeText = (intro, code) =>
  `${intro}\n\nYour code: ${code}\n\nThis code expires in 15 minutes. If you did not request it, you can ignore this email.`;

const sendVerificationCode = (to, code) =>
  sendMail({ to, subject: 'Verify your Satsang Spark email', text: codeText('Welcome to Satsang Spark!', code) });
const sendPasswordResetCode = (to, code) =>
  sendMail({ to, subject: 'Reset your Satsang Spark password', text: codeText('We received a request to reset your password.', code) });

module.exports = { sendMail, sendVerificationCode, sendPasswordResetCode, outbox };
