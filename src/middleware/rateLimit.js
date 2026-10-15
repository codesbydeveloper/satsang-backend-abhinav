const rateLimit = require('express-rate-limit');
const config = require('../config');

const make = (windowMs, limit, code = 'RATE_LIMITED') => rateLimit({
  windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false,
  skip: () => config.env === 'test',
  handler: (_req, res) => res.status(429).json({ error: { code, message: 'Too many attempts. Please wait and try again.' } }),
});

module.exports = {
  authLimiter: make(15 * 60 * 1000, 30),          // register / login / refresh
  codeLimiter: make(60 * 60 * 1000, 10),          // anything that sends an email code
  usernameLimiter: make(60 * 1000, 30),           // username availability checks
  adminLimiter: make(15 * 60 * 1000, 20),         // admin login steps
  generalLimiter: make(60 * 1000, 300),
};
