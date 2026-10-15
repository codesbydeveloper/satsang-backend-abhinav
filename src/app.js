const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const swaggerUi = require('swagger-ui-express');
const config = require('./config');
const { generalLimiter } = require('./middleware/rateLimit');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const openapi = require('./openapi');

function createApp() {
  const app = express();
  app.set('trust proxy', 1);                       // behind Hostinger's reverse proxy: use the real client IP
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: config.corsOrigins.length ? config.corsOrigins : false, credentials: false }));
  app.use(express.json({ limit: '100kb' }));
  if (config.env !== 'test') app.use(morgan('combined'));
  app.use(generalLimiter);

  app.get('/health', (_req, res) => res.json({ ok: true }));

  const api = express.Router();
  api.use(require('./routes/public'));
  api.use('/auth', require('./routes/auth'));
  api.use('/me', require('./routes/account'));
  api.use('/profiles', require('./routes/profiles'));
  api.use('/parent', require('./routes/parent'));
  api.use('/admin/auth', require('./routes/admin/auth'));
  api.use('/admin/admins', require('./routes/admin/admins'));
  api.use('/admin/users', require('./routes/admin/users'));
  api.use('/admin/blocked-words', require('./routes/admin/blockedWords'));
  api.use('/admin/audit-log', require('./routes/admin/auditLog'));
  app.use('/api/v1', api);

  app.get('/api-docs.json', (_req, res) => res.json(openapi));
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openapi, { customSiteTitle: 'Satsang Spark API' }));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
