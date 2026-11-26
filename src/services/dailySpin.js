const crypto = require('crypto');
const { query, tx } = require('../db');
const { ApiError, conflict, notFound } = require('../utils/errors');
const { toSql, fromSql } = require('../utils/time');
const sparks = require('./sparks');

/**
 * Daily Spark Spin (Milestone 2, chunk 2.3A, contract 6.7 + 8.3). One per playable profile, available 24 hours after
 * that profile's LAST SUCCESSFUL spin (rolling, not calendar based). An unclaimed spin never expires: it stays
 * available until the profile spins. Server time only; the server picks the segment (weighted) and credits the
 * Sparks through the ledger (type daily_spin) with the app's transactionId, so a retried request is processed once.
 */

const SPIN_HOURS = 24;
const SPIN_MS = SPIN_HOURS * 3600 * 1000;
const MAX_SEGMENT_SPARKS = 10000;
const MAX_WEIGHT = 1000;
const MIN_SEGMENTS = 2;
const MAX_SEGMENTS = 12;

/** Built-in wheel used while no admin has saved one. Placeholders TO BE CONFIRMED BY LOYADHAM. */
const DEFAULT_SEGMENTS = [
  { label: '5 Sparks', sparks: 5, weight: 25 },
  { label: '10 Sparks', sparks: 10, weight: 22 },
  { label: '15 Sparks', sparks: 15, weight: 18 },
  { label: '20 Sparks', sparks: 20, weight: 14 },
  { label: '25 Sparks', sparks: 25, weight: 10 },
  { label: '50 Sparks', sparks: 50, weight: 6 },
  { label: '75 Sparks', sparks: 75, weight: 3 },
  { label: '100 Sparks', sparks: 100, weight: 2 },
];

/** [{ index, label, sparks, weight }] in wheel order, plus isDefault. */
async function getSegments(c) {
  const q = c ? c.query : query;
  const rows = await q('SELECT * FROM spin_segments ORDER BY position');
  const list = rows.length ? rows : DEFAULT_SEGMENTS;
  return {
    isDefault: !rows.length,
    updatedBy: rows.length ? (rows[0].updated_by == null ? null : Number(rows[0].updated_by)) : null,
    updatedAt: rows.length ? rows[0].updated_at : null,
    segments: list.map((s, i) => ({ index: i, label: s.label ?? null, sparks: Number(s.sparks), weight: Number(s.weight) })),
  };
}

/** Replaces the wheel (already validated: 2–12 segments). Returns { from, to } (segment lists) for the audit log. */
async function setSegments(segments, adminId) {
  return tx(async (c) => {
    await c.query('SELECT position FROM spin_segments FOR UPDATE');
    const from = (await getSegments(c)).segments;
    await c.query('DELETE FROM spin_segments');
    for (const [i, s] of segments.entries()) {
      await c.query('INSERT INTO spin_segments (position, label, sparks, weight, updated_by, updated_at) VALUES (?,?,?,?,?,UTC_TIMESTAMP())',
        [i, s.label ?? null, s.sparks, s.weight, adminId]);
    }
    return { from, to: (await getSegments(c)).segments };
  });
}

/** Weighted pick with a cryptographic random number (the device never chooses). */
function pick(segments) {
  const total = segments.reduce((n, s) => n + s.weight, 0);
  let r = crypto.randomInt(total);
  for (const s of segments) {
    if (r < s.weight) return s;
    r -= s.weight;
  }
  return segments[segments.length - 1];
}

const lastSpin = async (c, profileId) =>
  (await c.query('SELECT * FROM daily_spins WHERE profile_id = ? ORDER BY spun_at DESC, id DESC LIMIT 1', [profileId]))[0];

function availability(last, now) {
  if (!last) return { available: true, nextAvailableAt: now.toISOString(), lastSpinAt: null };
  const next = new Date(fromSql(last.spun_at).getTime() + SPIN_MS);
  return { available: now.getTime() >= next.getTime(), nextAvailableAt: next.toISOString(), lastSpinAt: fromSql(last.spun_at).toISOString() };
}

const appSegments = (segments) => segments.map(({ index, label, sparks: s }) => ({ index, label, sparks: s }));

/** GET view: { available, nextAvailableAt, lastSpinAt, segments } (no weights: the app only draws the wheel). */
async function getStatus(profileId, now = new Date()) {
  const last = await lastSpin({ query }, profileId);
  return { ...availability(last, now), segments: appSegments((await getSegments()).segments) };
}

const resultView = (row, nextAvailableAt, balance, duplicate) => ({
  duplicate, transactionId: row.transaction_id, segmentIndex: Number(row.segment_index), label: row.label,
  reward: Number(row.sparks), spunAt: fromSql(row.spun_at).toISOString(), nextAvailableAt, balance,
});

/**
 * Spin for a profile. Same transactionId again → the first result (duplicate: true), nothing credited twice; the same
 * id used by another profile or for another Sparks transaction → 409 TRANSACTION_ID_CONFLICT. Not available yet →
 * 409 SPIN_NOT_AVAILABLE with details { nextAvailableAt }.
 */
async function spin(profileId, transactionId, now = new Date()) {
  const txId = sparks.normalizeTxId(transactionId);
  return tx(async (c) => {
    const p = (await c.query('SELECT id FROM profiles WHERE id = ? FOR UPDATE', [profileId]))[0];   // same lock as the ledger
    if (!p) throw notFound('PROFILE_NOT_FOUND', 'Profile not found');
    const before = (await c.query('SELECT * FROM daily_spins WHERE transaction_id = ?', [txId]))[0];
    if (before) {
      if (Number(before.profile_id) !== Number(profileId)) throw conflict('TRANSACTION_ID_CONFLICT', 'This transactionId was already used for a different Sparks transaction');
      const next = new Date(fromSql(before.spun_at).getTime() + SPIN_MS).toISOString();
      return resultView(before, next, await sparks.getBalance(profileId, c), true);
    }
    const a = availability(await lastSpin(c, profileId), now);
    if (!a.available) throw new ApiError(409, 'SPIN_NOT_AVAILABLE', 'The Daily Spin is not available yet', { nextAvailableAt: a.nextAvailableAt });
    const seg = pick((await getSegments(c)).segments);
    await c.query('INSERT INTO daily_spins (profile_id, transaction_id, segment_index, label, sparks, spun_at) VALUES (?,?,?,?,?,?)',
      [profileId, txId, seg.index, seg.label, seg.sparks, toSql(now)]);
    const r = await sparks.credit({ profileId, amount: seg.sparks, type: 'daily_spin', transactionId: txId, reference: `spin:segment:${seg.index}` }, c);
    const row = (await c.query('SELECT * FROM daily_spins WHERE transaction_id = ?', [txId]))[0];
    return resultView(row, new Date(fromSql(row.spun_at).getTime() + SPIN_MS).toISOString(), r.balance, false);
  });
}

module.exports = {
  SPIN_HOURS, MAX_SEGMENT_SPARKS, MAX_WEIGHT, MIN_SEGMENTS, MAX_SEGMENTS, DEFAULT_SEGMENTS,
  getSegments, setSegments, getStatus, spin, pick,
};
