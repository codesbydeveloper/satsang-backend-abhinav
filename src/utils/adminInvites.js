const config = require('../config');
const { query } = require('../db');
const { sha256, randomToken } = require('./tokens');
const { toSql, fromSql } = require('./time');
const { ApiError, notFound } = require('./errors');
const mailer = require('./mailer');

const INVITE_HOURS = 48;

/** A fresh invite: the raw token (only ever put in the email link), its hash and its expiry (UTC). */
function newInvite() {
  const token = randomToken();
  return { token, hash: sha256(token), expiresAt: toSql(new Date(Date.now() + INVITE_HOURS * 3600 * 1000)) };
}

const inviteLink = (token) => `${config.adminPanelUrl}/accept-invite?token=${encodeURIComponent(token)}`;

/** Email the invite. inviter = the Full Admin sending it. Throws 503 EMAIL_FAILED if the mail cannot be sent. */
async function emailInvite(invitee, inviter, token) {
  try {
    await mailer.sendAdminInvite(invitee.email, {
      name: invitee.name || invitee.email, invitedBy: inviter.name || inviter.email, role: invitee.role, link: inviteLink(token),
    });
  } catch (err) {
    console.error('ADMIN INVITE EMAIL FAILED', err.message);
    throw new ApiError(503, 'EMAIL_FAILED', 'We could not send the invite email. Please try again.');
  }
}

/** The invited (never activated) admin for a raw token. 404 INVITE_INVALID / 410 INVITE_EXPIRED. */
async function findInvite(token) {
  const a = token ? (await query('SELECT * FROM admins WHERE invite_token_hash = ? AND password_hash IS NULL', [sha256(String(token))]))[0] : null;
  if (!a) throw notFound('INVITE_INVALID', 'This invite link is not valid. Ask a Full Admin to send a new one.');
  if (fromSql(a.invite_expires_at) <= new Date()) throw new ApiError(410, 'INVITE_EXPIRED', 'This invite link has expired. Ask a Full Admin to send a new one.');
  return a;
}

/** "invited" (no password yet), "active" or "inactive" (deactivated). */
const adminStatus = (a) => (a.password_hash == null ? 'invited' : a.is_active ? 'active' : 'inactive');

module.exports = { INVITE_HOURS, newInvite, inviteLink, emailInvite, findInvite, adminStatus };
