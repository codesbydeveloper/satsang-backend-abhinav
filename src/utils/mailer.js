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

/** Admin Panel login code (second login step). Fixed text + the code only: no other data. */
const sendAdminLoginCode = (to, code) => sendMail({
  to,
  subject: 'Your Satsang Spark admin login code',
  text: `Your login code is ${code}. It expires in 10 minutes. If you didn't try to log in, change your password.`,
});

const ROLE_LABELS = { full_admin: 'Full Admin', content_editor: 'Content Editor' };
/** Admin Panel invite: the invitee's name, who invited them, their role and the link. Nothing else. */
const sendAdminInvite = (to, { name, invitedBy, role, link }) => sendMail({
  to,
  subject: "You've been invited to the Satsang Spark Admin Panel",
  text: `Hello ${name},

${invitedBy} has invited you to the Satsang Spark Admin Panel as ${ROLE_LABELS[role] || role}.

Open this link to choose your password:
${link}

This link expires in 48 hours.

After that, you log in with your email and password, and a code we email you each time.
`,
});

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * The shared branded HTML layout for Satsang Spark emails: a header bar, the title and the given lines (plain text,
 * escaped here), and a footer. Pass `rows` ([label, value]) for a small details table.
 */
function brandedHtml({ title, lines = [], rows = [], footer = 'Satsang Spark · Loyadham' }) {
  const p = (t) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.5;color:#2d2a26">${escapeHtml(t)}</p>`;
  const table = rows.length
    ? `<table role="presentation" style="border-collapse:collapse;margin:0 0 16px;font-size:14px">${rows.map(([k, v]) =>
      `<tr><td style="padding:4px 16px 4px 0;color:#6b645c;vertical-align:top">${escapeHtml(k)}</td><td style="padding:4px 0;color:#2d2a26">${escapeHtml(v)}</td></tr>`).join('')}</table>`
    : '';
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f6f1ea;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" style="border-collapse:collapse;background:#f6f1ea"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" style="max-width:560px;border-collapse:collapse;background:#ffffff;border-radius:8px;overflow:hidden">
<tr><td style="background:#e8742a;padding:16px 24px;color:#ffffff;font-size:18px;font-weight:bold">Satsang Spark</td></tr>
<tr><td style="padding:24px">
<h1 style="margin:0 0 16px;font-size:20px;color:#2d2a26">${escapeHtml(title)}</h1>
${lines.slice(0, 1).map(p).join('')}${table}${lines.slice(1).map(p).join('')}
</td></tr>
<tr><td style="padding:12px 24px;background:#faf7f2;color:#8a8279;font-size:12px">${escapeHtml(footer)}</td></tr>
</table></td></tr></table></body></html>`;
}

/** "23 Nov 2026, 15:04:05" in the given IANA zone. */
const formatIn = (timeZone, d) => new Intl.DateTimeFormat('en-GB', {
  timeZone, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
}).format(d);

/**
 * Sent to every active Full Admin after a new admin sign-in: who, when (Asia/Kolkata and UTC) and the device label.
 * No IP address, tokens or codes.
 */
function sendAdminLoginAlert(to, { name, email, role, at, device }) {
  const who = `${name || email} (${email}), ${ROLE_LABELS[role] || role}`;
  const when = `${formatIn('Asia/Kolkata', at)} IST (Asia/Kolkata) · ${formatIn('UTC', at)} UTC`;
  const warn = "If this wasn't expected, deactivate the admin in the panel.";
  const intro = 'An admin has just signed in to the Satsang Spark Admin Panel.';
  return sendMail({
    to,
    subject: 'Satsang Spark Admin – new sign-in',
    text: `${intro}

Who: ${who}
When: ${when}
Device: ${device}

${warn}
`,
    html: brandedHtml({ title: 'New admin sign-in', lines: [intro, warn], rows: [['Who', who], ['When', when], ['Device', device]] }),
  });
}

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

const mailer = { sendMail, brandedHtml, sendVerificationCode, sendPasswordResetCode, sendAdminLoginCode, sendAdminInvite, sendAdminLoginAlert, sendAccountDeletedEmail, outbox };
module.exports = mailer;
