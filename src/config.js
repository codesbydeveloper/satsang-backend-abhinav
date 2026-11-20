require('dotenv').config({ quiet: true, path: process.env.NODE_ENV === 'test' ? '.env.test' : '.env' });

const bool = (v, d = false) => (v === undefined ? d : String(v).toLowerCase() === 'true');

const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),
  // Admin Panel base URL for invite links. Required (https) in production.
  adminPanelUrl: (process.env.ADMIN_PANEL_URL || (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:5173')).trim().replace(/\/+$/, ''),
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

if (config.env === 'production') {
  const weak = [];
  if (config.jwtSecret.startsWith('dev-')) weak.push('JWT_SECRET');
  if (config.adminJwtSecret.startsWith('dev-')) weak.push('ADMIN_JWT_SECRET');
  if (weak.length) throw new Error(`Refusing to start in production with default secrets: ${weak.join(', ')}`);
  let panel = null;
  try { panel = new URL(config.adminPanelUrl); } catch { /* missing or invalid */ }
  if (!panel || panel.protocol !== 'https:') throw new Error('Refusing to start in production: ADMIN_PANEL_URL must be set to the Admin Panel https:// address');
}

module.exports = config;
