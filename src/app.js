const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const swaggerUi = require('swagger-ui-express');
const config = require('./config');
const { query } = require('./db');
const { generalLimiter } = require('./middleware/rateLimit');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const openapi = require('./openapi');
const { jsonTimestamps } = require('./utils/time');

// Access log = morgan "combined", but admin invite tokens never reach the log (path /admin/auth/invite/<token>, or a
// ?token= in the referrer when the Admin Panel's accept-invite page calls the API).
const redact = (s) => String(s || '').replace(/(\/admin\/auth\/invite\/)[^/?#]+/g, '$1[redacted]').replace(/([?&]token=)[^&#]*/g, '$1[redacted]');
morgan.token('safe-url', (req) => redact(req.originalUrl || req.url));
morgan.token('safe-referrer', (req) => redact(req.get('referer') || req.get('referrer')) || '-');
const SAFE_COMBINED = ':remote-addr - :remote-user [:date[clf]] ":method :safe-url HTTP/:http-version" :status :res[content-length] ":safe-referrer" ":user-agent"';

function createApp() {
  const app = express();
  app.set('trust proxy', 1);                       // behind Hostinger's reverse proxy: use the real client IP
  app.set('json replacer', jsonTimestamps);        // DATETIMEs (UTC) leave the API as ISO strings ending in "Z"
  app.use(helmet({ contentSecurityPolicy: false }));
  // Google Sheet export: server-to-server only (X-Export-Key), so it is mounted before CORS: no browser page can read it.
  app.use('/api/v1/export', require('./routes/exportSheet'));
  // exposedHeaders: the Admin Panel reads the CSV export's file name (another origin).
  app.use(cors({ origin: config.corsOrigins.length ? config.corsOrigins : false, credentials: false, exposedHeaders: ['Content-Disposition'] }));
  app.use(express.json({ limit: '100kb' }));
  if (config.env !== 'test') app.use(morgan(SAFE_COMBINED));
  app.use(generalLimiter);

  // Root status check: no config values or error details, only whether the DB answers.
  app.get('/', async (_req, res) => {
    let database = 'connected';
    try { await query('SELECT 1'); } catch { database = 'error'; }
    res.json({ success: true, message: 'Satsang Spark API is running', status: 'ok', database });
  });
  app.get('/health', (_req, res) => res.json({ ok: true }));
  // Public files for emails (the logo). Mail apps load them from another origin, so CORP must allow cross-origin.
  app.use('/static', express.static(path.join(__dirname, '..', 'public', 'static'), {
    maxAge: '7d', index: false, dotfiles: 'ignore', fallthrough: true,
    setHeaders: (res) => res.set('Cross-Origin-Resource-Policy', 'cross-origin'),
  }));

  const api = express.Router();
  api.use(require('./routes/public'));
  api.use('/auth', require('./routes/auth'));
  api.use('/me', require('./routes/account'));
  api.use('/profiles', require('./routes/profiles'));
  api.use('/parent', require('./routes/parent'));
  api.use('/admin/auth', require('./routes/admin/auth'));
  api.use('/admin/me', require('./routes/admin/me'));
  api.use('/admin/admins', require('./routes/admin/admins'));
  api.use('/admin/users', require('./routes/admin/users'));
  api.use('/admin/profiles', require('./routes/admin/profiles'));
  api.use('/admin/blocked-words', require('./routes/admin/blockedWords'));
  api.use('/admin/audit-log', require('./routes/admin/auditLog'));
  api.use('/admin/dashboard', require('./routes/admin/dashboard'));
  api.use('/admin/deletion-requests', require('./routes/admin/deletionRequests'));
  api.use('/admin/referrals', require('./routes/admin/referrals'));
  app.use('/api/v1', api);

  app.get('/api-docs.json', (_req, res) => res.json(openapi));
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openapi, { customSiteTitle: 'Satsang Spark API' }));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
