const crypto = require('crypto');
const { query, tx } = require('../db');
const { ApiError, badRequest, conflict, notFound } = require('../utils/errors');
const { AGE_GROUPS, AGE_GROUP_KEYS } = require('../utils/ageGroup');

/**
 * Sparks Economy core ledger (Milestone 2, contract 8.1). The ONE place that changes a profile's Sparks.
 *
 * - Sparks belong to the playable profile (an independent account's own profile, each child separately), never pooled
 *   across a parent account. Tables: sparks_transactions (the ledger) + profile_sparks (balance row), migration 019.
 * - Server authoritative: every change runs inside a DB transaction holding the profile row lock (SELECT … FOR UPDATE
 *   on profiles: that row always exists, so there are no gap locks and concurrent calls for one profile queue up).
 * - Idempotent on transactionId (UNIQUE, stored lower case): the same id again returns the first result with
 *   duplicate: true and changes nothing; the same id for another profile, type or amount is 409 TRANSACTION_ID_CONFLICT.
 * - The balance can never go below zero: 409 INSUFFICIENT_SPARKS.
 * - Spending (purchases) never lowers lifetime earned (leaderboards). A negative admin adjustment is a correction: it
 *   lowers balance and lifetime earned. Reversing a credit lowers both too; reversing a purchase refunds it.
 *
 * Every mutating function takes an optional tx connection `c` (from db.tx) as the last argument, so callers can
 * combine a Sparks change with their own writes atomically; without it the function runs its own transaction.
 */

const TYPES = ['signup_bonus', 'student_verified', 'student_interest', 'referral', 'explore_import', 'daily_spin', 'streak',
  'quiz', 'game', 'puzzle', 'learn', 'purchase', 'admin_adjust'];
const SPEND_TYPES = ['purchase'];
const EARN_TYPES = TYPES.filter((t) => !SPEND_TYPES.includes(t) && t !== 'admin_adjust');
const MAX_AMOUNT = 1000000;
const TX_ID = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;

/** Activities whose reward is configured per age group (sparks_reward_config). */
const REWARD_ACTIVITIES = ['quiz', 'game', 'puzzle', 'learn'];
const MAX_REWARD = 10000;

const run = (c, fn) => (c ? fn(c) : tx(fn));
const newTransactionId = () => crypto.randomUUID();

function normalizeTxId(id) {
  const s = String(id ?? '').trim().toLowerCase();
  if (!TX_ID.test(s)) throw badRequest('INVALID_TRANSACTION_ID', 'transactionId must be 1–64 letters, digits, _ . : or -');
  return s;
}
function checkAmount(n, { allowNegative = false } = {}) {
  if (!Number.isInteger(n) || n === 0 || Math.abs(n) > MAX_AMOUNT || (!allowNegative && n < 0)) {
    throw badRequest('INVALID_AMOUNT', `amount must be a whole number ${allowNegative ? 'other than 0' : 'above 0'}, at most ${MAX_AMOUNT}`);
  }
}
const clip = (s, n) => (s == null ? null : String(s).slice(0, n));

const balanceView = (b) => ({
  balance: Number(b?.balance || 0),
  lifetimeEarned: Number(b?.lifetime_earned || 0),
  lifetimeSpent: Number(b?.lifetime_spent || 0),
  pending: Number(b?.pending || 0),
});

/** Full row (Admin Panel). */
const txView = (t) => ({
  id: Number(t.id), profileId: Number(t.profile_id), transactionId: t.transaction_id, amount: Number(t.amount), type: t.type,
  status: t.status, reference: t.reference, note: t.note, createdBy: t.created_by == null ? null : Number(t.created_by),
  createdAt: t.created_at, verifiedAt: t.verified_at, reversedAt: t.reversed_at,
  reversedBy: t.reversed_by == null ? null : Number(t.reversed_by), reversedReason: t.reversed_reason,
});
/** What the app shows: no admin ids or admin notes. */
const appTxView = (t) => ({
  id: Number(t.id), transactionId: t.transaction_id, amount: Number(t.amount), type: t.type, status: t.status,
  reference: t.reference, createdAt: t.created_at, verifiedAt: t.verified_at, reversedAt: t.reversed_at,
});

/** Locks the profile (mutex for its Sparks) and returns its balance row, creating it on first use. */
async function lockProfile(c, profileId) {
  const p = (await c.query('SELECT id FROM profiles WHERE id = ? FOR UPDATE', [profileId]))[0];
  if (!p) throw notFound('PROFILE_NOT_FOUND', 'Profile not found');
  await c.query('INSERT IGNORE INTO profile_sparks (profile_id) VALUES (?)', [profileId]);
  return (await c.query('SELECT * FROM profile_sparks WHERE profile_id = ? FOR UPDATE', [profileId]))[0];
}

/**
 * An earlier row with this transaction id: the same operation → that row (duplicate); anything else → 409.
 * `lock` reads the latest committed row (after a duplicate-key error); without it the read is a plain one, which
 * already sees everything committed for this profile because the profile lock was taken first.
 */
async function existing(c, transactionId, o, lock = false) {
  const t = (await c.query(`SELECT * FROM sparks_transactions WHERE transaction_id = ?${lock ? ' LOCK IN SHARE MODE' : ''}`, [transactionId]))[0];
  if (!t) return null;
  if (Number(t.profile_id) !== Number(o.profileId) || t.type !== o.type || Number(t.amount) !== o.amount) {
    throw conflict('TRANSACTION_ID_CONFLICT', 'This transactionId was already used for a different Sparks transaction');
  }
  return t;
}

const insufficient = (balance, needed) => new ApiError(409, 'INSUFFICIENT_SPARKS', 'Not enough Sparks', { balance, needed });

/**
 * The core write: lock, idempotency check, balance check, ledger row, balance row — in that order, inside `c`.
 * o: { profileId, amount (signed), type, status, transactionId, reference, note, createdBy }
 * d: balance deltas { balance, earned, spent, pending }
 */
async function write(c, o, d) {
  const bal = await lockProfile(c, o.profileId);
  const before = await existing(c, o.transactionId, o);
  if (before) return { duplicate: true, transaction: before, balance: balanceView(bal) };
  if (Number(bal.balance) + d.balance < 0) throw insufficient(Number(bal.balance), -d.balance);
  let r;
  try {
    r = await c.query(
      `INSERT INTO sparks_transactions (profile_id, amount, type, status, transaction_id, reference, note, created_by, created_at, verified_at)
       VALUES (?,?,?,?,?,?,?,?,UTC_TIMESTAMP(),${o.status === 'verified' ? 'UTC_TIMESTAMP()' : 'NULL'})`,
      [o.profileId, o.amount, o.type, o.status, o.transactionId, clip(o.reference, 100), clip(o.note, 255), o.createdBy ?? null]);
  } catch (e) {
    if (e.code !== 'ER_DUP_ENTRY') throw e;
    const t = await existing(c, o.transactionId, o, true);   // written meanwhile by another profile's call
    if (t) return { duplicate: true, transaction: t, balance: balanceView(bal) };
    throw e;
  }
  await applyDelta(c, o.profileId, d);
  const t = (await c.query('SELECT * FROM sparks_transactions WHERE id = ?', [r.insertId]))[0];
  const after = (await c.query('SELECT * FROM profile_sparks WHERE profile_id = ?', [o.profileId]))[0];
  return { duplicate: false, transaction: t, balance: balanceView(after) };
}

const applyDelta = (c, profileId, d) => c.query(
  `UPDATE profile_sparks SET balance = balance + ?, lifetime_earned = lifetime_earned + ?, lifetime_spent = lifetime_spent + ?,
          pending = pending + ?, updated_at = UTC_TIMESTAMP() WHERE profile_id = ?`,
  [d.balance || 0, d.earned || 0, d.spent || 0, d.pending || 0, profileId]);

function base(o, { types, allowNegative = false }) {
  if (!types.includes(o.type)) throw badRequest('INVALID_SPARKS_TYPE', `type must be one of ${types.join(', ')}`);
  checkAmount(o.amount, { allowNegative });
  return { ...o, profileId: Number(o.profileId), transactionId: normalizeTxId(o.transactionId ?? newTransactionId()) };
}

/** Verified earning: +balance, +lifetime earned. o: { profileId, amount > 0, type, transactionId?, reference?, note?, createdBy? } */
async function credit(o, c) {
  const x = base(o, { types: EARN_TYPES });
  return run(c, (cc) => write(cc, { ...x, status: 'verified' }, { balance: x.amount, earned: x.amount }));
}

/** Spending (a purchase): −balance, +lifetime spent; lifetime earned is untouched. amount is the positive price. */
async function spend(o, c) {
  const x = base({ type: 'purchase', ...o }, { types: SPEND_TYPES });
  return run(c, (cc) => write(cc, { ...x, amount: -x.amount, status: 'verified' }, { balance: -x.amount, spent: x.amount }));
}

/** Offline / not-yet-earned Sparks: +pending only, until verifyPending (or reverse). amount > 0. */
async function addPending(o, c) {
  const x = base(o, { types: EARN_TYPES });
  return run(c, (cc) => write(cc, { ...x, status: 'pending' }, { pending: x.amount }));
}

/** Full Admin correction: ± amount (a deduction cannot take the balance below zero); reason and admin id required. */
async function adjust(o, c) {
  if (!o.createdBy) throw badRequest('ADMIN_REQUIRED', 'An admin adjustment needs the admin');
  if (!o.note || !String(o.note).trim()) throw badRequest('REASON_REQUIRED', 'A reason is required');
  const x = base({ ...o, type: 'admin_adjust' }, { types: ['admin_adjust'], allowNegative: true });
  return run(c, (cc) => write(cc, { ...x, status: 'verified' }, { balance: x.amount, earned: x.amount }));
}

/** Loads a ledger row by transaction id with its profile locked first (same lock order as every other call). */
async function lockTransaction(c, transactionId) {
  const id = normalizeTxId(transactionId);
  const peek = (await c.query('SELECT profile_id FROM sparks_transactions WHERE transaction_id = ?', [id]))[0];
  if (!peek) throw notFound('TRANSACTION_NOT_FOUND', 'Sparks transaction not found');
  const bal = await lockProfile(c, peek.profile_id);
  const t = (await c.query('SELECT * FROM sparks_transactions WHERE transaction_id = ? FOR UPDATE', [id]))[0];
  return { t, bal };
}

/** pending → verified: −pending, +balance, +lifetime earned. Already verified: no-op (duplicate). Reversed: 409. */
async function verifyPending(transactionId, c) {
  return run(c, async (cc) => {
    const { t, bal } = await lockTransaction(cc, transactionId);
    if (t.status === 'verified') return { duplicate: true, transaction: t, balance: balanceView(bal) };
    if (t.status === 'reversed') throw conflict('TRANSACTION_REVERSED', 'This Sparks transaction was reversed');
    const a = Number(t.amount);
    await cc.query("UPDATE sparks_transactions SET status = 'verified', verified_at = UTC_TIMESTAMP() WHERE id = ?", [t.id]);
    await applyDelta(cc, t.profile_id, { pending: -a, balance: a, earned: a });
    return {
      duplicate: false,
      transaction: (await cc.query('SELECT * FROM sparks_transactions WHERE id = ?', [t.id]))[0],
      balance: balanceView((await cc.query('SELECT * FROM profile_sparks WHERE profile_id = ?', [t.profile_id]))[0]),
    };
  });
}

/**
 * Undo a transaction (status reversed; the row stays in the history). Already reversed: no-op (duplicate).
 *  pending          → −pending
 *  verified credit  → −balance, −lifetime earned (409 INSUFFICIENT_SPARKS if already spent)
 *  verified spend   → refund: +balance, −lifetime spent
 *  admin deduction  → +balance, +lifetime earned
 */
async function reverse(transactionId, { reason = null, adminId = null } = {}, c) {
  return run(c, async (cc) => {
    const { t, bal } = await lockTransaction(cc, transactionId);
    if (t.status === 'reversed') return { duplicate: true, transaction: t, balance: balanceView(bal) };
    const a = Number(t.amount);
    let d;
    if (t.status === 'pending') d = { pending: -a };
    else if (a < 0 && t.type !== 'admin_adjust') d = { balance: -a, spent: a };
    else d = { balance: -a, earned: -a };
    if (Number(bal.balance) + (d.balance || 0) < 0) throw insufficient(Number(bal.balance), -(d.balance || 0));
    await cc.query(
      `UPDATE sparks_transactions SET status = 'reversed', reversed_from = ?, reversed_at = UTC_TIMESTAMP(), reversed_by = ?, reversed_reason = ?
       WHERE id = ?`, [t.status, adminId, clip(reason, 255), t.id]);
    await applyDelta(cc, t.profile_id, d);
    return {
      duplicate: false,
      transaction: (await cc.query('SELECT * FROM sparks_transactions WHERE id = ?', [t.id]))[0],
      balance: balanceView((await cc.query('SELECT * FROM profile_sparks WHERE profile_id = ?', [t.profile_id]))[0]),
    };
  });
}

/** { balance, lifetimeEarned, lifetimeSpent, pending } (zeros before the first transaction). */
async function getBalance(profileId, c) {
  const q = c ? c.query : query;
  return balanceView((await q('SELECT * FROM profile_sparks WHERE profile_id = ?', [profileId]))[0]);
}

/** Balances for many profiles: Map(profileId → balance). */
async function balancesOf(profileIds) {
  if (!profileIds.length) return new Map();
  const rows = await query(`SELECT * FROM profile_sparks WHERE profile_id IN (${profileIds.map(() => '?').join(',')})`, profileIds);
  return new Map(rows.map((r) => [Number(r.profile_id), balanceView(r)]));
}

/** Newest first. { items (raw rows), page, pageSize, total } */
async function getHistory(profileId, { page = 1, pageSize = 25, status = null, type = null } = {}) {
  const where = ['profile_id = ?'];
  const params = [profileId];
  if (status) { where.push('status = ?'); params.push(status); }
  if (type) { where.push('type = ?'); params.push(type); }
  const sql = where.join(' AND ');
  const total = Number((await query(`SELECT COUNT(*) AS n FROM sparks_transactions WHERE ${sql}`, params))[0].n);
  const items = await query(`SELECT * FROM sparks_transactions WHERE ${sql} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]);
  return { items, page, pageSize, total };
}

// ---- Reward config (per activity AND per age group; Full Admin; no app release needed) ----

const configView = (r) => ({
  activity: r.activity, ageGroup: r.age_group, sparks: Number(r.sparks), defaultSparks: Number(r.default_sparks),
  isDefault: !!r.is_default, updatedBy: r.updated_by == null ? null : Number(r.updated_by), updatedAt: r.updated_at,
});

async function getRewardConfig() {
  const rows = await query('SELECT * FROM sparks_reward_config');
  const order = (r) => REWARD_ACTIVITIES.indexOf(r.activity) * 100 + AGE_GROUP_KEYS.indexOf(r.age_group);
  return {
    activities: REWARD_ACTIVITIES,
    ageGroups: AGE_GROUPS.map((g) => ({ key: g.key, label: g.label })),
    rewards: rows.filter((r) => REWARD_ACTIVITIES.includes(r.activity) && AGE_GROUP_KEYS.includes(r.age_group))
      .sort((a, b) => order(a) - order(b)).map(configView),
    note: 'Seeded values are defaults to be confirmed by Loyadham.',
  };
}

/** changes: [{ activity, ageGroup, sparks }] (already validated). Returns the rows that changed: [{ activity, ageGroup, from, to }]. */
async function setRewardConfig(changes, adminId) {
  return tx(async (c) => {
    const changed = [];
    for (const ch of changes) {
      const cur = (await c.query('SELECT sparks FROM sparks_reward_config WHERE activity = ? AND age_group = ? FOR UPDATE', [ch.activity, ch.ageGroup]))[0];
      if (cur && Number(cur.sparks) === ch.sparks) continue;
      await c.query(
        `INSERT INTO sparks_reward_config (activity, age_group, sparks, default_sparks, is_default, updated_by, updated_at)
         VALUES (?,?,?,?,0,?,UTC_TIMESTAMP())
         ON DUPLICATE KEY UPDATE sparks = VALUES(sparks), is_default = 0, updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)`,
        [ch.activity, ch.ageGroup, ch.sparks, ch.sparks, adminId]);
      changed.push({ activity: ch.activity, ageGroup: ch.ageGroup, from: cur ? Number(cur.sparks) : null, to: ch.sparks });
    }
    return changed;
  });
}

/** Sparks for one completed activity at the profile's age group (0 when not configured). Used by Milestone 3/4 activities. */
async function rewardFor(activity, ageGroup) {
  const r = (await query('SELECT sparks FROM sparks_reward_config WHERE activity = ? AND age_group = ?', [activity, ageGroup]))[0];
  return r ? Number(r.sparks) : 0;
}

module.exports = {
  TYPES, SPEND_TYPES, EARN_TYPES, MAX_AMOUNT, REWARD_ACTIVITIES, MAX_REWARD,
  newTransactionId, normalizeTxId, balanceView, txView, appTxView,
  credit, spend, addPending, adjust, verifyPending, reverse, getBalance, balancesOf, getHistory,
  getRewardConfig, setRewardConfig, rewardFor,
};
