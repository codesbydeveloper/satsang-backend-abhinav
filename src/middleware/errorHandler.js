const { ApiError } = require('../utils/errors');
const config = require('../config');

const notFoundHandler = (req, res) =>
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` } });

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Request body is not valid JSON' } });
  }
  if (err && err.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({ error: { code: 'DUPLICATE', message: 'That value is already in use' } });
  }
  console.error('UNHANDLED', req.method, req.originalUrl, err);
  res.status(500).json({ error: { code: 'INTERNAL', message: config.env === 'production' ? 'Something went wrong' : String(err.message) } });
}

module.exports = { errorHandler, notFoundHandler };
