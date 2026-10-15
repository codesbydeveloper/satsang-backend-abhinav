const express = require('express');
const { z } = require('zod');
const { query } = require('../../db');
const validate = require('../../middleware/validate');
const { requireAdmin, requireRole } = require('../../middleware/adminAuth');
const { notFound, conflict } = require('../../utils/errors');
const { audit } = require('../../utils/audit');

const router = express.Router();
router.use(requireAdmin, requireRole('full_admin', 'content_editor'));

router.get('/', async (_req, res) => {
  res.json({ words: await query('SELECT id, word, kind, created_at AS createdAt FROM blocked_words ORDER BY kind, word') });
});

// Add English words, Gujarati-script words or transliterations (e.g. Gujarati written in Latin letters).
router.post('/', validate(z.object({ word: z.string().trim().min(2).max(100), kind: z.enum(['blocked', 'reserved']).default('blocked') })), async (req, res) => {
  const word = req.body.word.normalize('NFC').toLowerCase();
  if ((await query('SELECT 1 FROM blocked_words WHERE word = ?', [word])).length) throw conflict('WORD_EXISTS', 'That word is already on the list');
  const r = await query('INSERT INTO blocked_words (word, kind, created_by) VALUES (?,?,?)', [word, req.body.kind, req.admin.id]);
  await audit(req, 'blocked_word.added', { entityType: 'blocked_word', entityId: r.insertId, details: { word, kind: req.body.kind } });
  res.status(201).json({ id: r.insertId, word, kind: req.body.kind });
});

router.delete('/:id', validate(z.object({ id: z.coerce.number().int().positive() }), 'params'), async (req, res) => {
  const w = (await query('SELECT * FROM blocked_words WHERE id = ?', [req.validated.params.id]))[0];
  if (!w) throw notFound('WORD_NOT_FOUND', 'Word not found');
  await query('DELETE FROM blocked_words WHERE id = ?', [w.id]);
  await audit(req, 'blocked_word.removed', { entityType: 'blocked_word', entityId: w.id, details: { word: w.word } });
  res.json({ deleted: true });
});

module.exports = router;
