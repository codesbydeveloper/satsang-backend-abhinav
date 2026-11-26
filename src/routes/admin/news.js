const express = require('express');
const { z } = require('zod');
const { query } = require('../../db');
const validate = require('../../middleware/validate');
const { requireAdmin, requireRole } = require('../../middleware/adminAuth');
const { audit } = require('../../utils/audit');
const { notFound } = require('../../utils/errors');
const { toSql } = require('../../utils/time');
const { newsView } = require('../../utils/home');

// News & Updates (Milestone 2, chunk 2.3A, contract 6.7): Full Admin and Content Editor. Every change is audited.
const router = express.Router();
router.use(requireAdmin, requireRole('full_admin', 'content_editor'));

const like = (s) => `%${s.replace(/[\\%_]/g, '\\$&')}%`;
const idParam = z.object({ id: z.coerce.number().int().positive() });
const load = async (id) => {
  const r = (await query('SELECT * FROM news WHERE id = ?', [id]))[0];
  if (!r) throw notFound('NEWS_NOT_FOUND', 'News item not found');
  return r;
};

// status: published (active, publish date passed) | scheduled (active, future date) | inactive | all
router.get('/', validate(z.object({
  q: z.string().trim().max(100).default(''),
  status: z.enum(['all', 'published', 'scheduled', 'inactive']).default('all'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
}), 'query'), async (req, res) => {
  const { q, status, page, pageSize } = req.validated.query;
  const conds = [];
  const params = [];
  if (status === 'published') conds.push('is_active = 1 AND publish_at <= UTC_TIMESTAMP()');
  if (status === 'scheduled') conds.push('is_active = 1 AND publish_at > UTC_TIMESTAMP()');
  if (status === 'inactive') conds.push('is_active = 0');
  if (q) { conds.push('(title_en LIKE ? OR title_gu LIKE ? OR body_en LIKE ? OR body_gu LIKE ?)'); params.push(like(q), like(q), like(q), like(q)); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const total = Number((await query(`SELECT COUNT(*) AS n FROM news ${where}`, params))[0].n);
  const rows = await query(`SELECT * FROM news ${where} ORDER BY is_pinned DESC, publish_at DESC, id DESC LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]);
  res.json({ page, pageSize, total, items: rows.map((r) => newsView(r, { admin: true })) });
});

router.get('/:id', validate(idParam, 'params'), async (req, res) => {
  res.json({ news: newsView(await load(req.validated.params.id), { admin: true }) });
});

// English title + body required; Gujarati optional (the app falls back to English). publishAt: ISO date-time (UTC
// when no offset), default now. imageUrl: https only.
const fields = {
  titleEn: z.string().trim().min(1).max(150),
  titleGu: z.string().trim().max(150).nullable(),
  bodyEn: z.string().trim().min(1).max(10000),
  bodyGu: z.string().trim().max(10000).nullable(),
  imageUrl: z.url({ protocol: /^https$/ }).max(500).nullable(),
  publishAt: z.iso.datetime({ offset: true }),
  active: z.boolean(),
  pinned: z.boolean(),
};
const createSchema = z.object({
  ...fields,
  titleGu: fields.titleGu.optional(), bodyGu: fields.bodyGu.optional(), imageUrl: fields.imageUrl.optional(),
  publishAt: fields.publishAt.optional(), active: fields.active.default(true), pinned: fields.pinned.default(false),
});
const patchSchema = z.object(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.optional()])))
  .refine((b) => Object.keys(b).length > 0, 'Send at least one field');

const COLUMNS = { titleEn: 'title_en', titleGu: 'title_gu', bodyEn: 'body_en', bodyGu: 'body_gu', imageUrl: 'image_url', publishAt: 'publish_at', active: 'is_active', pinned: 'is_pinned' };
const dbValue = (k, v) => {
  if (v === null || v === undefined) return null;
  if (k === 'publishAt') return toSql(new Date(v));
  if (k === 'active' || k === 'pinned') return v ? 1 : 0;
  if (typeof v === 'string') return v.normalize('NFC') || null;
  return v;
};

router.post('/', validate(createSchema), async (req, res) => {
  const b = { ...req.body, publishAt: req.body.publishAt || new Date().toISOString() };
  const keys = Object.keys(COLUMNS).filter((k) => b[k] !== undefined);
  const r = await query(
    `INSERT INTO news (${keys.map((k) => COLUMNS[k]).join(', ')}, created_by, created_at) VALUES (${keys.map(() => '?').join(',')}, ?, UTC_TIMESTAMP())`,
    [...keys.map((k) => dbValue(k, b[k])), req.admin.id]);
  const row = await load(r.insertId);
  await audit(req, 'news.created', { entityType: 'news', entityId: row.id, details: { titleEn: row.title_en, publishAt: row.publish_at, active: !!row.is_active, pinned: !!row.is_pinned } });
  res.status(201).json({ news: newsView(row, { admin: true }) });
});

router.patch('/:id', validate(idParam, 'params'), validate(patchSchema), async (req, res) => {
  const before = newsView(await load(req.validated.params.id), { admin: true });
  const keys = Object.keys(req.body);
  await query(`UPDATE news SET ${keys.map((k) => `${COLUMNS[k]} = ?`).join(', ')}, updated_by = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?`,
    [...keys.map((k) => dbValue(k, req.body[k])), req.admin.id, before.id]);
  const after = newsView(await load(before.id), { admin: true });
  const pickField = (v, k) => ({ titleEn: v.title.en, titleGu: v.title.gu, bodyEn: v.body.en, bodyGu: v.body.gu, imageUrl: v.imageUrl, publishAt: v.publishAt, active: v.active, pinned: v.pinned }[k]);
  // body texts can be long: the audit records that they changed, not the text
  const changed = Object.fromEntries(keys.filter((k) => pickField(before, k) !== pickField(after, k))
    .map((k) => [k, k.startsWith('body') ? { changed: true } : { from: pickField(before, k), to: pickField(after, k) }]));
  if (Object.keys(changed).length) await audit(req, 'news.updated', { entityType: 'news', entityId: before.id, details: changed });
  res.json({ news: after });
});

router.delete('/:id', validate(idParam, 'params'), async (req, res) => {
  const row = await load(req.validated.params.id);
  await query('DELETE FROM news WHERE id = ?', [row.id]);
  await audit(req, 'news.deleted', { entityType: 'news', entityId: row.id, details: { titleEn: row.title_en } });
  res.json({ deleted: true, id: Number(row.id) });
});

module.exports = router;
