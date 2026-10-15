require('dotenv').config({ quiet: true, path: process.env.NODE_ENV === 'test' ? '.env.test' : '.env' });

const bool = (v, d = false) => (v === undefined ? d : String(v).toLowerCase() === 'true');

const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),
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
  adminTotpKey: process.env.ADMIN_TOTP_ENC_KEY || '0'.repeat(64),
  accessTokenTtl: process.env.ACCESS_TOKEN_TTL || '1h',
  refreshTokenDays: Number(process.env.REFRESH_TOKEN_DAYS || 60),
  adminTokenTtl: process.env.ADMIN_TOKEN_TTL || '8h',
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
};

if (config.env === 'production') {
  const weak = [];
  if (config.jwtSecret.startsWith('dev-')) weak.push('JWT_SECRET');
  if (config.adminJwtSecret.startsWith('dev-')) weak.push('ADMIN_JWT_SECRET');
  if (/^0+$/.test(config.adminTotpKey)) weak.push('ADMIN_TOTP_ENC_KEY');
  if (weak.length) throw new Error(`Refusing to start in production with default secrets: ${weak.join(', ')}`);
}

module.exports = config;
