const config = require('../config');
const { query } = require('../db');
const { sha256, randomToken } = require('./tokens');
const { toSql, addDays } = require('./time');
const { audit } = require('./audit');
const mailer = require('./mailer');

const MAX_TRUSTED_DEVICES = 10;
const ALERT_MINUTES = 10;   // at most one login alert per admin per 10 minutes

// ---------- device label ----------

/** "Chrome on Windows" from a user agent. Only the browser and OS names: nothing that identifies the machine. */
function deviceLabel(ua) {
  const s = String(ua || '');
  const browser =
    /Edg(e|A|iOS)?\//.test(s) ? 'Edge'
      : /OPR\/|Opera/.test(s) ? 'Opera'
        : /SamsungBrowser\//.test(s) ? 'Samsung Internet'
          : /Firefox\/|FxiOS\//.test(s) ? 'Firefox'
            : /Chrome\/|CriOS\//.test(s) ? 'Chrome'
              : /Safari\//.test(s) && /Version\//.test(s) ? 'Safari'
                : null;
  const os =
    /iPhone|iPad|iPod/.test(s) ? 'iOS'
      : /Android/.test(s) ? 'Android'
        : /CrOS/.test(s) ? 'ChromeOS'
          : /Windows/.test(s) ? 'Windows'
            : /Mac OS X|Macintosh/.test(s) ? 'macOS'
              : /Linux/.test(s) ? 'Linux'
                : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser || os || 'Unknown device';
}
const labelOf = (req) => deviceLabel(req.get && req.get('user-agent'));

// ---------- trusted devices ----------

const deviceView = (d) => ({ id: d.id, label: d.label, createdAt: d.created_at, lastUsedAt: d.last_used_at });

/** The live trusted device of this admin for a raw device token, or null. */
async function findTrustedDevice(adminId, deviceToken) {
  if (!deviceToken) return null;
  return (await query('SELECT * FROM admin_trusted_devices WHERE admin_id = ? AND token_hash = ? AND revoked_at IS NULL',
    [adminId, sha256(String(deviceToken))]))[0] || null;
}

/** Trust the current browser. Returns { device, deviceToken } (the raw token is only ever returned here, once). */
async function trustDevice(req, admin) {
  const deviceToken = randomToken();
  const label = labelOf(req);
  const r = await query('INSERT INTO admin_trusted_devices (admin_id, token_hash, label, last_used_at) VALUES (?,?,?, UTC_TIMESTAMP())',
    [admin.id, sha256(deviceToken), label]);
  await audit(req, 'admin.device_trusted', { admin, entityType: 'admin', entityId: admin.id, details: { deviceId: r.insertId, label } });
  // keep at most 10 live devices: the oldest ones go
  const extra = await query(
    `SELECT id FROM admin_trusted_devices WHERE admin_id = ? AND revoked_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1000 OFFSET ${MAX_TRUSTED_DEVICES}`,
    [admin.id]);
  for (const { id } of extra) {
    await query('UPDATE admin_trusted_devices SET revoked_at = UTC_TIMESTAMP() WHERE id = ? AND revoked_at IS NULL', [id]);
    await audit(req, 'admin.device_revoked', { admin, entityType: 'admin', entityId: admin.id, details: { deviceId: id, reason: 'device_limit' } });
  }
  const device = (await query('SELECT * FROM admin_trusted_devices WHERE id = ?', [r.insertId]))[0];
  return { device, deviceToken };
}

const listDevices = async (adminId) =>
  (await query('SELECT * FROM admin_trusted_devices WHERE admin_id = ? AND revoked_at IS NULL ORDER BY created_at DESC, id DESC', [adminId])).map(deviceView);

/** Revoke one live device of an admin. false if there is no such live device. */
async function revokeDevice(req, adminId, deviceId, reason) {
  const r = await query('UPDATE admin_trusted_devices SET revoked_at = UTC_TIMESTAMP() WHERE id = ? AND admin_id = ? AND revoked_at IS NULL', [deviceId, adminId]);
  if (!r.affectedRows) return false;
  await audit(req, 'admin.device_revoked', { entityType: 'admin', entityId: adminId, details: { deviceId, reason } });
  return true;
}

/** Revoke every live device of an admin; audited once with the count (when there were any). Returns the count. */
async function revokeAllDevices(req, adminId, reason) {
  const r = await query('UPDATE admin_trusted_devices SET revoked_at = UTC_TIMESTAMP() WHERE admin_id = ? AND revoked_at IS NULL', [adminId]);
  if (r.affectedRows) await audit(req, 'admin.device_revoked', { entityType: 'admin', entityId: adminId, details: { all: true, count: r.affectedRows, reason } });
  return r.affectedRows;
}

// ---------- refresh tokens ("Remember me") ----------

/** A new 30-day refresh token for this admin. Returns { refreshToken, refreshExpiresAt }. */
async function issueRefreshToken(admin) {
  const refreshToken = randomToken();
  const expires = addDays(new Date(), config.adminRefreshDays);
  await query('INSERT INTO admin_refresh_tokens (admin_id, token_hash, token_version, expires_at) VALUES (?,?,?,?)',
    [admin.id, sha256(refreshToken), admin.token_version, toSql(expires)]);
  return { refreshToken, refreshExpiresAt: expires.toISOString() };
}

/**
 * Rotate a refresh token: the old one stops working, a new one (30 days from now) is returned with the admin row.
 * null if the token is unknown, used, revoked, expired, or the admin's sessions were ended since it was issued.
 */
async function rotateRefreshToken(raw) {
  const row = (await query('SELECT * FROM admin_refresh_tokens WHERE token_hash = ?', [sha256(String(raw || ''))]))[0];
  if (!row || row.revoked_at || new Date(String(row.expires_at).replace(' ', 'T') + 'Z') <= new Date()) return null;
  const admin = (await query('SELECT * FROM admins WHERE id = ?', [row.admin_id]))[0];
  if (!admin || !admin.is_active || admin.token_version !== row.token_version) return null;
  const refreshToken = randomToken();
  const expires = addDays(new Date(), config.adminRefreshDays);
  // only the request that still matches the old hash wins (two parallel refreshes cannot both succeed)
  const r = await query(
    'UPDATE admin_refresh_tokens SET token_hash = ?, expires_at = ?, last_used_at = UTC_TIMESTAMP() WHERE id = ? AND token_hash = ? AND revoked_at IS NULL',
    [sha256(refreshToken), toSql(expires), row.id, row.token_hash]);
  if (!r.affectedRows) return null;
  return { admin, refreshToken, refreshExpiresAt: expires.toISOString() };
}

const revokeAllRefreshTokens = (adminId) =>
  query('UPDATE admin_refresh_tokens SET revoked_at = UTC_TIMESTAMP() WHERE admin_id = ? AND revoked_at IS NULL', [adminId]);

// ---------- login alerts ----------

const pending = new Set();

/**
 * Email every active Full Admin about a new sign-in, in the background: never blocks or fails the login.
 * At most one alert per signed-in admin per 10 minutes (admins.last_login_alert_at, claimed atomically).
 */
function queueLoginAlert(admin, device) {
  const at = new Date();
  const job = (async () => {
    const claim = await query(
      `UPDATE admins SET last_login_alert_at = UTC_TIMESTAMP() WHERE id = ?
         AND (last_login_alert_at IS NULL OR last_login_alert_at <= UTC_TIMESTAMP() - INTERVAL ${ALERT_MINUTES} MINUTE)`, [admin.id]);
    if (!claim.affectedRows) return;
    const to = await query("SELECT email FROM admins WHERE role = 'full_admin' AND is_active = 1 AND password_hash IS NOT NULL ORDER BY id");
    for (const { email } of to) {
      try {
        await mailer.sendAdminLoginAlert(email, { name: admin.name, email: admin.email, role: admin.role, at, device });
      } catch (err) {
        console.error('ADMIN LOGIN ALERT EMAIL FAILED', err.message);
      }
    }
  })().catch((err) => console.error('ADMIN LOGIN ALERT FAILED', err.message)).finally(() => pending.delete(job));
  pending.add(job);
  return job;
}

/** Wait for queued login alerts (tests). */
const flushLoginAlerts = () => Promise.all([...pending]);

/**
 * End everything for an admin after a password change/reset, deactivation or role change: refresh tokens and every
 * trusted device (the caller bumps token_version, which ends the access tokens).
 */
async function endAdminAccess(req, adminId, reason) {
  await revokeAllRefreshTokens(adminId);
  await revokeAllDevices(req, adminId, reason);
}

module.exports = {
  MAX_TRUSTED_DEVICES, ALERT_MINUTES, deviceLabel, labelOf, deviceView,
  findTrustedDevice, trustDevice, listDevices, revokeDevice, revokeAllDevices,
  issueRefreshToken, rotateRefreshToken, revokeAllRefreshTokens,
  queueLoginAlert, flushLoginAlerts, endAdminAccess,
};
