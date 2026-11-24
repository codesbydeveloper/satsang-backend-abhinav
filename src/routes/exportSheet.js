const crypto = require('crypto');
const express = require('express');
require('../config');   // loads .env (SHEET_EXPORT_KEY)
const { sheetExportLimiter } = require('../middleware/rateLimit');
const { unauthorized } = require('../utils/errors');
const { audit } = require('../utils/audit');
const { queryUsers, EXPORT_COLUMNS, exportRows } = require('../utils/usersTable');

/**
 * GET /api/v1/export/sheet: the Users table for Loyadham's Google Sheet (the Admin Panel repo's docs/google-sheet/Code.gs pulls it hourly).
 * No admin login: the caller sends header X-Export-Key = SHEET_EXPORT_KEY. With SHEET_EXPORT_KEY empty the route
 * does not exist (404). Mounted before the CORS middleware, so no browser page can read it. Rate limited 30/hour.
 * Returns only the Users table columns (+ the ids that link families): never hashes, tokens or other fields.
 * Every family, default sort (newest first). Audited as sheet.export with the row count only.
 */
const router = express.Router();

// SHEET_EXPORT_KEY: random, 48+ characters (openssl rand -hex 32). Empty = the endpoint is off (404). Kept out of
// src/config.js on purpose; read on each request (tests switch it).
const MIN_KEY = 48;
const sheetExportKey = () => (process.env.SHEET_EXPORT_KEY || '').trim();
if (sheetExportKey() && sheetExportKey().length < MIN_KEY) throw new Error('SHEET_EXPORT_KEY must be at least 48 characters (e.g. openssl rand -hex 32), or empty to turn the Google Sheet export off');

const digest = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest();
// Constant time whatever the lengths: both sides are hashed to 32 bytes first.
const keyMatches = (given, expected) => crypto.timingSafeEqual(digest(given), digest(expected));

const NOT_FOUND = (req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` } });

router.get('/sheet', (req, res, next) => (sheetExportKey().length >= MIN_KEY ? next() : NOT_FOUND(req, res)), sheetExportLimiter, async (req, res) => {
  const given = req.get('x-export-key');
  if (!given || !keyMatches(given, sheetExportKey())) throw unauthorized('EXPORT_KEY_INVALID', 'Missing or wrong X-Export-Key');
  const { rows } = await queryUsers({ pageSize: null });
  await audit(req, 'sheet.export', { details: { count: rows.length } });
  res.set('Cache-Control', 'no-store');
  res.json({
    generatedAt: new Date().toISOString(),
    columns: EXPORT_COLUMNS.map(({ key, label, type }) => ({ key, label, type })),
    rows: exportRows(rows),
  });
});

module.exports = router;
