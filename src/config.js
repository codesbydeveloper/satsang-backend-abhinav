require('dotenv').config({ quiet: true, path: process.env.NODE_ENV === 'test' ? '.env.test' : '.env' });

const bool = (v, d = false) => (v === undefined ? d : String(v).toLowerCase() === 'true');

const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),
  // Admin Panel base URL for invite links. Required (https) in production.
  adminPanelUrl: (process.env.ADMIN_PANEL_URL || (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:5173')).trim().replace(/\/+$/, ''),
  // This API's public address, used for absolute URLs in emails (the logo at /static/email-logo.png). https in production.
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || 'http://localhost:3000').trim().replace(/\/+$/, ''),
  corsOrigins: (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'satsang_spark',
  },
  jwtSecret: process.env.JWT_SECRET || 'dev-user-secret-change-me',
  adminJwtSecret: process.env.ADMIN_JWT_SECRET || 'dev-admin-secret-change-me',
  accessTokenTtl: process.env.ACCESS_TOKEN_TTL || '1h',
  refreshTokenDays: Number(process.env.REFRESH_TOKEN_DAYS || 60),
  adminTokenTtl: process.env.ADMIN_TOKEN_TTL || '8h',
  // Admin "Remember me": refresh token lifetime in days (rolling: each refresh restarts it).
  adminRefreshDays: Number(process.env.ADMIN_REFRESH_DAYS || 30),
  // At most this many Full Admins (active + invited). Everyone else is a Content Editor.
  maxFullAdmins: Number(process.env.MAX_FULL_ADMINS || 3),
  // How long a deleted account's email stays on its deletion request (Full Admins only), then it is erased.
  retainedEmailDays: Number(process.env.RETAINED_EMAIL_DAYS || 30),
  // Time zone for the Admin Panel dashboard ("new registrations today" and the chart days). IANA name.
  // Not the game day: streaks, daily challenges and leaderboards stay on America/New_York (utils/time.js).
  dashboardTimeZone: (process.env.DASHBOARD_TIMEZONE || 'Asia/Kolkata').trim(),
  mail: {
    transport: process.env.MAIL_TRANSPORT || 'console',
    from: process.env.MAIL_FROM || 'Satsang Spark <no-reply@example.org>',
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: bool(process.env.SMTP_SECURE),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  // Student status (Loyadham Online Classes): Sparks a Full Admin's verification / interest confirmation gives the
  // profile, and the interest form the app opens ("" = the app hides the form button).
  studentVerifiedSparks: Number(process.env.STUDENT_VERIFIED_SPARKS ?? 10),
  studentInterestSparks: Number(process.env.STUDENT_INTEREST_SPARKS ?? 5),
  studentInterestFormUrl: (process.env.STUDENT_INTEREST_FORM_URL || '').trim(),
  minAppVersion: process.env.MIN_APP_VERSION || '1.0.0',
  privacyPolicyVersion: process.env.PRIVACY_POLICY_VERSION || '1.0',
  parentalConsentAge: Number(process.env.PARENTAL_CONSENT_AGE || 13),
  bcryptRounds: process.env.NODE_ENV === 'test' ? 4 : 12,
  // Temporary debugging switch: show the real error message in 500 responses even in production.
  exposeErrors: bool(process.env.EXPOSE_ERRORS),
};

try { new Intl.DateTimeFormat('en', { timeZone: config.dashboardTimeZone }); } catch {
  throw new Error(`DASHBOARD_TIMEZONE "${config.dashboardTimeZone}" is not a valid IANA time zone (e.g. Asia/Kolkata)`);
}

for (const [name, v, min, max] of [['MAX_FULL_ADMINS', config.maxFullAdmins, 1, 100], ['ADMIN_REFRESH_DAYS', config.adminRefreshDays, 1, 365]]) {
  if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${name} must be a whole number from ${min} to ${max}`);
}
for (const [name, v] of [['STUDENT_VERIFIED_SPARKS', config.studentVerifiedSparks], ['STUDENT_INTEREST_SPARKS', config.studentInterestSparks]]) {
  if (!Number.isInteger(v) || v < 0 || v > 100000) throw new Error(`${name} must be a whole number from 0 to 100000`);
}
if (config.studentInterestFormUrl) {
  let u = null;
  try { u = new URL(config.studentInterestFormUrl); } catch { /* invalid */ }
  if (!u || !['https:', 'http:'].includes(u.protocol)) throw new Error('STUDENT_INTEREST_FORM_URL must be an http(s) address or empty');
}

if (config.env === 'production') {
  const weak = [];
  if (config.jwtSecret.startsWith('dev-')) weak.push('JWT_SECRET');
  if (config.adminJwtSecret.startsWith('dev-')) weak.push('ADMIN_JWT_SECRET');
  if (weak.length) throw new Error(`Refusing to start in production with default secrets: ${weak.join(', ')}`);
  let panel = null;
  try { panel = new URL(config.adminPanelUrl); } catch { /* missing or invalid */ }
  if (!panel || panel.protocol !== 'https:') throw new Error('Refusing to start in production: ADMIN_PANEL_URL must be set to the Admin Panel https:// address');
  let pub = null;
  try { pub = new URL(config.publicBaseUrl); } catch { /* invalid */ }
  if (!process.env.PUBLIC_BASE_URL || !pub || pub.protocol !== 'https:') throw new Error('Refusing to start in production: PUBLIC_BASE_URL must be set to this API\'s https:// address (email logo)');
}

module.exports = config;
