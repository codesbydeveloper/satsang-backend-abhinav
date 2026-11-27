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

// ---------- the shared branded layout (every email) ----------

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The official logo, served by this API at /static/email-logo.png (absolute URL: mail apps cannot load relative ones). */
const logoUrl = () => `${config.publicBaseUrl}/static/email-logo.png`;
const SIGNATURE = '— Team Satsang Spark';

const FONT = "Inter,Arial,Helvetica,sans-serif";
const INK = '#1f2a44';
const MUTED = '#8a8279';
/** One block of the layout as HTML. Every text value is escaped here. */
const BLOCKS = {
  p: (t) => `<p style="margin:0 0 14px;font-size:16px;line-height:1.5;color:${INK}">${escapeHtml(t)}</p>`,
  label: (t) => `<p style="margin:8px 0 8px;font-size:13px;font-weight:bold;letter-spacing:1.5px;font-variant:small-caps;text-transform:uppercase;color:#6b645c">${escapeHtml(t)}</p>`,
  code: (t) => `<p style="margin:0 0 18px;padding:16px 8px;background:#fdf6ec;border:1px solid #f1dcbc;border-radius:10px;font-size:38px;line-height:1.2;font-weight:bold;letter-spacing:8px;color:${INK};font-family:${FONT}">${escapeHtml(t)}</p>`,
  small: (t) => `<p style="margin:0 0 14px;font-size:13px;line-height:1.5;color:${MUTED}">${escapeHtml(t)}</p>`,
  sign: (t = SIGNATURE) => `<p style="margin:20px 0 0;font-size:15px;font-weight:bold;color:${INK}">${escapeHtml(t === true ? SIGNATURE : t)}</p>`,
  rows: (rows) => `<table role="presentation" align="center" style="border-collapse:collapse;margin:0 auto 16px;font-size:14px;text-align:left">${rows.map(([k, v]) =>
    `<tr><td style="padding:4px 14px 4px 0;color:#6b645c;vertical-align:top">${escapeHtml(k)}</td><td style="padding:4px 0;color:${INK}">${escapeHtml(v)}</td></tr>`).join('')}</table>`,
  button: ({ label, href }) => `<p style="margin:4px 0 12px"><a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 22px;background:#e8742a;color:#ffffff;border-radius:8px;font-size:16px;font-weight:bold;text-decoration:none">${escapeHtml(label)}</a></p>`
    + `<p style="margin:0 0 16px;font-size:12px;line-height:1.4;color:${MUTED};word-break:break-all">${escapeHtml(href)}</p>`,
};

/**
 * The shared branded HTML layout for Satsang Spark emails: the logo, a big bold title, then the blocks, centred in a
 * 480px column (full width on phones). Each block is one of { p }, { label } (small caps), { code } (very large, in
 * the code box), { small } (grey), { rows: [[label, value]] } (details table), { button: { label, href } } and
 * { sign: true | text } ("— Team Satsang Spark").
 */
function brandedHtml({ title, blocks = [] }) {
  const body = blocks.map((b) => { const [k, v] = Object.entries(b)[0]; return BLOCKS[k](v); }).join('\n');
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#f6f1ea;font-family:${FONT};-webkit-text-size-adjust:100%">
<table role="presentation" width="100%" style="border-collapse:collapse;background:#f6f1ea"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" style="max-width:480px;width:100%;border-collapse:collapse;background:#ffffff;border-radius:12px">
<tr><td align="center" style="padding:24px 24px 4px"><img src="${escapeHtml(logoUrl())}" width="240" alt="Satsang Spark" style="display:block;width:240px;max-width:100%;height:auto;border:0"></td></tr>
<tr><td align="center" style="padding:12px 24px 28px;text-align:center;font-family:${FONT}">
<h1 style="margin:0 0 18px;font-size:26px;line-height:1.25;font-weight:bold;color:${INK}">${escapeHtml(title)}</h1>
${body}
</td></tr>
</table></td></tr></table></body></html>`;
}

/** Fallback for an email sent without its own HTML: the subject as the title, each text paragraph as a block. */
const htmlFromText = (subject, text) =>
  brandedHtml({ title: subject, blocks: String(text || '').split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean).map((p) => ({ p })) });

/** Every email goes out as plain text + the branded HTML layout. */
async function sendMail({ to, subject, text, html }) {
  const body = html || htmlFromText(subject, text);
  const t = getTransport();
  if (!t) {
    outbox.push({ to, subject, text, html: body });
    if (outbox.length > 50) outbox.shift();
    if (config.env !== 'test') console.log(`[mail:console] to=${to} subject="${subject}"\n${text}\n`);
    return;
  }
  await t.sendMail({ from: config.mail.from, to, subject, text, html: body });
}

// ---------- app users ----------

const CODE_MINUTES = 15;   // app verification / reset codes: utils/emailCodes.js uses this same value for expires_at
const NO_SHARE = '🔒 Please do not share this code with anyone.';

/**
 * Code emails are shaped so Gmail shows its built-in "Copy code" box (no button or script in the email): the subject
 * starts with the code ("<CODE> is your Satsang Spark … code"), the text part opens with "Your Satsang Spark … code is
 * <CODE>.", and the code is plain digits everywhere (one text element in the HTML; its spacing is CSS letter-spacing).
 */
const codeSubject = (code, what) => `${code} is your Satsang Spark ${what}`;
const codeLine = (code, what) => `Your Satsang Spark ${what} is ${code}.`;

/** Client content (Part A). The code is also on its own line after "CODE:" so it is easy to extract from the text part. */
function sendVerificationCode(to, code) {
  const title = '🙏 Welcome to Satsang Spark!';
  const welcome = "We're excited to have you join us!";
  const label = '✨ YOUR VERIFICATION CODE:';
  const expires = `⏳ This code expires in ${CODE_MINUTES} minutes.`;
  const ignore = "If you didn't request this code, you can safely ignore this email.";
  return sendMail({
    to,
    subject: codeSubject(code, 'verification code'),
    text: `${codeLine(code, 'verification code')}

${title}

${welcome}

${label}
${code}

${expires}
${NO_SHARE}

${ignore}

${SIGNATURE}
`,
    html: brandedHtml({ title, blocks: [{ p: welcome }, { label }, { code }, { p: expires }, { p: NO_SHARE }, { small: ignore }, { sign: true }] }),
  });
}

function sendPasswordResetCode(to, code) {
  const intro = 'We received a request to reset your password.';
  const label = '✨ YOUR PASSWORD RESET CODE:';
  const expires = `⏳ This code expires in ${CODE_MINUTES} minutes.`;
  const ignore = "If you didn't request this code, you can safely ignore this email. Your password stays the same.";
  return sendMail({
    to,
    subject: codeSubject(code, 'password reset code'),
    text: `${codeLine(code, 'password reset code')}

${intro}

${label}
${code}

${expires}
${NO_SHARE}

${ignore}

${SIGNATURE}
`,
    html: brandedHtml({ title: 'Reset your password', blocks: [{ p: intro }, { label }, { code }, { p: expires }, { p: NO_SHARE }, { small: ignore }, { sign: true }] }),
  });
}

/** Sent when an account deletion completes (client content, Part A). Fixed text only: no personal data. */
const DELETED_LINES = [
  'Hello,',
  'Your Satsang Spark account has been successfully deleted.',
  'All data associated with your account has been permanently deleted, and you have been logged out of all devices.',
  "We're grateful you were part of the Satsang Spark community. Thank you for being with us! 💛",
  'Wishing you all the best.',
];
const sendAccountDeletedEmail = (to) => sendMail({
  to,
  subject: '🙏 Satsang Spark – Account Deletion Confirmation',
  text: `${DELETED_LINES.join('\n\n')}\n\n${SIGNATURE}\n`,
  html: brandedHtml({ title: 'Account Deletion Confirmation', blocks: [...DELETED_LINES.map((p) => ({ p })), { sign: true }] }),
});

// ---------- Admin Panel ----------

/** Admin Panel login code (second login step). Fixed text + the code only: no other data. */
const sendAdminLoginCode = (to, code) => sendMail({
  to,
  subject: codeSubject(code, 'admin login code'),
  text: `${codeLine(code, 'admin login code')} It expires in 10 minutes. If you didn't try to log in, change your password.`,
  html: brandedHtml({
    title: 'Your admin login code',
    blocks: [{ label: 'Your login code:' }, { code }, { p: 'It expires in 10 minutes.' }, { small: "If you didn't try to log in, change your password." }],
  }),
});

const ROLE_LABELS = { full_admin: 'Full Admin', content_editor: 'Content Editor' };
/** Admin Panel invite: the invitee's name, who invited them, their role and the link. Nothing else. */
const sendAdminInvite = (to, { name, invitedBy, role, link }) => {
  const invited = `${invitedBy} has invited you to the Satsang Spark Admin Panel as ${ROLE_LABELS[role] || role}.`;
  const after = 'After that, you log in with your email and password, and a code we email you when you sign in on a new device.';
  return sendMail({
    to,
    subject: "You've been invited to the Satsang Spark Admin Panel",
    text: `Hello ${name},

${invited}

Open this link to choose your password:
${link}

This link expires in 48 hours.

${after}
`,
    html: brandedHtml({
      title: "You've been invited",
      blocks: [
        { p: `Hello ${name},` }, { p: invited }, { p: 'Open this link to choose your password. It expires in 48 hours.' },
        { button: { label: 'Choose your password', href: link } }, { small: after },
      ],
    }),
  });
};

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
    html: brandedHtml({ title: 'New admin sign-in', blocks: [{ p: intro }, { rows: [['Who', who], ['When', when], ['Device', device]] }, { p: warn }] }),
  });
}

const mailer = {
  sendMail, brandedHtml, logoUrl, CODE_MINUTES, SIGNATURE,
  sendVerificationCode, sendPasswordResetCode, sendAdminLoginCode, sendAdminInvite, sendAdminLoginAlert, sendAccountDeletedEmail, outbox,
};
module.exports = mailer;
