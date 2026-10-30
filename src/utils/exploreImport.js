const { z } = require('zod');
const S = require('./schemas');
const { toSql } = require('./time');
const { badRequest, conflict, forbidden, notFound } = require('./errors');

/**
 * Explore → account (client, 30 Oct 2026). The app keeps an Explore record on the device (no account, nothing
 * personal): nickname, avatar, path, language, and what was earned / bought / played / learned, each entry with a
 * unique transaction id. After sign-up the app uploads it with POST /me/explore-import.
 *
 * - Once per account: the first call picks the target profile (an independent account's own profile, or a parent's
 *   child) and applies the avatar / path to it; later calls must name the same profile (the app sends large records
 *   in batches, and retries after a lost response). Another profile → 409 EXPLORE_ALREADY_IMPORTED.
 * - Idempotent by transaction id: an entry already stored (by any call) is counted as a duplicate, never twice.
 * - The nickname is not sent: the app pre-fills it as the username in Profile setup / Add child, where it is
 *   live-checked and can be edited, so the import never overrides the user's choice.
 * - The server stays the final authority: entries are stored as 'pending_import' and nothing is credited here.
 *   TODO(M2 Sparks ledger / Dress Up): verify and credit 'sparks' and 'purchase' entries (creditPendingImports).
 *   TODO(M3 Quizzes / Puzzles / Learn): re-verify 'score' and 'progress' entries the same way.
 */

/** Entries per request (the JSON body limit is 100 kB; the app sends larger records in batches). */
const MAX_ITEMS_PER_REQUEST = 200;

const code = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,39}$/, 'Use a short lowercase code');
const txId = z.string().uuid('Use a UUID transaction id');
const at = z.string().max(40).refine((s) => !Number.isNaN(Date.parse(s)) && Date.parse(s) <= Date.now() + 24 * 3600000, 'Use an ISO 8601 time, not in the future');

const schema = z.object({
  profileId: z.number().int().positive().optional(),
  avatarId: S.avatarId.optional(),
  mode: S.mode.optional(),
  sparks: z.array(z.object({ txId, amount: z.number().int().min(1).max(100000), reason: code, at })).max(MAX_ITEMS_PER_REQUEST).default([]),
  purchases: z.array(z.object({ txId, itemId: code, sparks: z.number().int().min(0).max(100000), at })).max(MAX_ITEMS_PER_REQUEST).default([]),
  scores: z.array(z.object({ txId, game: code, itemId: code.nullable().optional(), score: z.number().int().min(0).max(100000000), at })).max(MAX_ITEMS_PER_REQUEST).default([]),
  progress: z.array(z.object({ txId, area: code, itemId: code, value: z.number().int().min(0).max(1000000), at })).max(MAX_ITEMS_PER_REQUEST).default([]),
}).refine((b) => b.sparks.length + b.purchases.length + b.scores.length + b.progress.length <= MAX_ITEMS_PER_REQUEST,
  `Send at most ${MAX_ITEMS_PER_REQUEST} entries per request`);

/** The entries of a request as rows: [kind, code, itemId, amount, at, txId]. */
function rowsOf(b) {
  return [
    ...b.sparks.map((e) => ['sparks', e.reason, null, e.amount, e.at, e.txId]),
    ...b.purchases.map((e) => ['purchase', e.itemId, null, e.sparks, e.at, e.txId]),
    ...b.scores.map((e) => ['score', e.game, e.itemId || null, e.score, e.at, e.txId]),
    ...b.progress.map((e) => ['progress', e.area, e.itemId, e.value, e.at, e.txId]),
  ];
}

/** Which profile receives the import (rules in the header). */
async function targetProfile(c, req) {
  const a = req.account;
  const wanted = req.body.profileId;
  if (a.account_type === 'parent') {
    if (req.profileId) throw forbidden('PARENT_MODE_REQUIRED', 'Switch to the parent area first');
    if (!wanted) throw badRequest('PROFILE_ID_REQUIRED', 'Choose the child profile that receives the Explore progress');
    const kid = (await c.query('SELECT * FROM profiles WHERE id = ? AND account_id = ? AND is_child = 1', [wanted, a.id]))[0];
    if (!kid) throw notFound('PROFILE_NOT_FOUND', 'Profile not found');
    return kid;
  }
  const own = (await c.query('SELECT * FROM profiles WHERE account_id = ? ORDER BY id LIMIT 1', [a.id]))[0];
  if (!own) throw conflict('PROFILE_REQUIRED', 'Create your profile first');
  if (wanted && wanted !== own.id) throw notFound('PROFILE_NOT_FOUND', 'Profile not found');
  return own;
}

/** Runs one import call inside a transaction. Returns the response body. */
async function importExplore(c, req) {
  const a = req.account;
  const b = req.body;
  const profile = await targetProfile(c, req);
  const done = (await c.query('SELECT profile_id FROM explore_imports WHERE account_id = ? FOR UPDATE', [a.id]))[0];
  if (done && Number(done.profile_id) !== Number(profile.id)) {
    throw conflict('EXPLORE_ALREADY_IMPORTED', 'Explore progress was already added to another profile of this account');
  }
  const first = !done;
  if (first) {
    await c.query('INSERT INTO explore_imports (account_id, profile_id) VALUES (?, ?)', [a.id, profile.id]);
    if (b.avatarId !== undefined) await c.query('UPDATE profiles SET avatar_id = ? WHERE id = ?', [b.avatarId, profile.id]);
    if (b.mode !== undefined) await c.query('UPDATE profiles SET mode = ? WHERE id = ?', [b.mode, profile.id]);
  }

  let imported = 0;
  for (const [kind, codeValue, itemId, amount, when, id] of rowsOf(b)) {
    const r = await c.query(
      `INSERT IGNORE INTO explore_import_items (tx_id, account_id, profile_id, kind, code, item_id, amount, client_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id.toLowerCase(), a.id, profile.id, kind, codeValue, itemId, amount, toSql(new Date(Date.parse(when)))]);
    imported += r.affectedRows ? 1 : 0;
  }
  const total = rowsOf(b).length;
  if (imported) await c.query('UPDATE explore_imports SET items = items + ? WHERE account_id = ?', [imported, a.id]);
  return {
    profileId: profile.id,
    firstImport: first,
    imported,
    duplicates: total - imported,
    pending: await pendingSummary(c, profile.id),
  };
}

/** What waits for Milestone 2/3 verification for a profile: { sparks (sum), purchases, scores, progress }. */
async function pendingSummary(c, profileId) {
  const rows = await c.query(
    "SELECT kind, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM explore_import_items WHERE profile_id = ? AND status = 'pending_import' GROUP BY kind",
    [profileId]);
  const by = Object.fromEntries(rows.map((r) => [r.kind, r]));
  return {
    sparks: Number((by.sparks || {}).total || 0),
    purchases: Number((by.purchase || {}).n || 0),
    scores: Number((by.score || {}).n || 0),
    progress: Number((by.progress || {}).n || 0),
  };
}

/**
 * Hook for Milestone 2/3: verify the profile's pending Explore entries and credit them (Sparks ledger with the
 * entry's tx_id as the unique transaction id, Dress Up items, scores, progress), setting 'credited' or 'rejected'.
 * TODO(M2/M3): implement; today nothing is credited (the server is the final authority).
 */
async function creditPendingImports(/* c, profileId */) {
  return { credited: 0, rejected: 0 };
}

module.exports = { MAX_ITEMS_PER_REQUEST, schema, importExplore, pendingSummary, creditPendingImports };
