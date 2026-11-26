const { query, tx } = require('../db');
const { conflict, notFound } = require('../utils/errors');
const { etDate, TZ } = require('../utils/time');
const sparks = require('./sparks');

/**
 * Streak Bonus (Milestone 2, chunk 2.3A, contract 6.7 + 8.3). A login streak per playable profile on game days
 * (America/New_York calendar days, DST-aware; server time only).
 *
 * - Opening the app on a game day (POST /profiles/:id/streak/check-in, or the activity heartbeat) counts that day once.
 *   The next game day → streak + 1; a missed game day → the streak starts again at 1.
 * - Each counted day adds the amount for that streak day to an UNCLAIMED bonus (amounts admin-configurable; days after
 *   the last configured day use the last amount).
 * - Claiming credits the unclaimed bonus through the Sparks ledger (type streak) and resets ONLY the unclaimed amount;
 *   the streak keeps counting.
 * - When the streak breaks before a claim, the unclaimed bonus is lost (kept in lost_unclaimed for the app to show).
 */

const MAX_DAYS = 30;
const MAX_DAY_SPARKS = 10000;

/** Built-in amounts (streak day 1, 2, … 7+) used while no admin has saved any. TO BE CONFIRMED BY LOYADHAM. */
const DEFAULT_AMOUNTS = [5, 10, 15, 20, 25, 30, 50];

/** The calendar day before YYYY-MM-DD (plain calendar arithmetic: DST only matters for which day an instant is in). */
function dayBefore(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

async function getAmounts(c) {
  const q = c ? c.query : query;
  const rows = await q('SELECT * FROM streak_bonus_amounts ORDER BY day');
  return {
    isDefault: !rows.length,
    amounts: rows.length ? rows.map((r) => Number(r.sparks)) : [...DEFAULT_AMOUNTS],
    updatedBy: rows.length ? (rows[0].updated_by == null ? null : Number(rows[0].updated_by)) : null,
    updatedAt: rows.length ? rows[0].updated_at : null,
  };
}

/** Replaces the amounts (already validated: 1–30 whole numbers). Returns { from, to }. */
async function setAmounts(amounts, adminId) {
  return tx(async (c) => {
    await c.query('SELECT day FROM streak_bonus_amounts FOR UPDATE');
    const from = (await getAmounts(c)).amounts;
    await c.query('DELETE FROM streak_bonus_amounts');
    for (const [i, s] of amounts.entries()) {
      await c.query('INSERT INTO streak_bonus_amounts (day, sparks, updated_by, updated_at) VALUES (?,?,?,UTC_TIMESTAMP())', [i + 1, s, adminId]);
    }
    return { from, to: (await getAmounts(c)).amounts };
  });
}

const amountFor = (amounts, day) => amounts[Math.min(day, amounts.length) - 1] || 0;

/** Is the stored streak still alive on `today` (last active today or yesterday)? */
const alive = (row, today) => !!row && !!row.last_active_day && (row.last_active_day === today || row.last_active_day === dayBefore(today));

/** What the app shows. A broken streak reads as 0 / 0 even before the next check-in writes it. */
function view(row, today, amounts) {
  const ok = alive(row, today);
  const current = ok ? Number(row.current_streak) : 0;
  const checkedInToday = ok && row.last_active_day === today;
  return {
    currentStreak: current,
    bestStreak: Number(row?.best_streak || 0),
    unclaimed: ok ? Number(row.unclaimed) : 0,
    lastActiveDay: row?.last_active_day || null,
    checkedInToday,
    // what the NEXT counted day will add: tomorrow if today is counted, otherwise today
    nextDayBonus: amountFor(amounts, checkedInToday ? current + 1 : (ok ? current + 1 : 1)),
    // bonus a break took away: the last break's loss, or (streak already broken, not yet written) what it is losing
    lostUnclaimed: ok ? Number(row.lost_unclaimed || 0) : Number(row?.unclaimed || 0),
    gameDay: today, gameTimeZone: TZ,
    amounts,
  };
}

const lockProfile = async (c, profileId) => {
  const p = (await c.query('SELECT id FROM profiles WHERE id = ? FOR UPDATE', [profileId]))[0];
  if (!p) throw notFound('PROFILE_NOT_FOUND', 'Profile not found');
};
const loadRow = async (c, profileId) => (await c.query('SELECT * FROM profile_streaks WHERE profile_id = ?', [profileId]))[0];

async function getStreak(profileId, now = new Date()) {
  const { amounts } = await getAmounts();
  return view(await loadRow({ query }, profileId), etDate(now), amounts);
}

/** Counts today (once per game day) inside `c` (profile already locked). Returns { counted, added, lost }. */
async function countToday(c, profileId, now, amounts) {
  const today = etDate(now);
  const row = await loadRow(c, profileId);
  if (row && row.last_active_day === today) return { counted: false, added: 0, lost: 0 };
  const continues = alive(row, today);
  const streak = continues ? Number(row.current_streak) + 1 : 1;
  const lost = !continues && row ? Number(row.unclaimed) : 0;
  const added = amountFor(amounts, streak);
  const unclaimed = (continues ? Number(row.unclaimed) : 0) + added;
  await c.query(
    `INSERT INTO profile_streaks (profile_id, current_streak, best_streak, last_active_day, unclaimed, lost_unclaimed, updated_at)
     VALUES (?,?,?,?,?,?,UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE current_streak = VALUES(current_streak), best_streak = GREATEST(best_streak, VALUES(best_streak)),
       last_active_day = VALUES(last_active_day), unclaimed = VALUES(unclaimed), lost_unclaimed = VALUES(lost_unclaimed), updated_at = VALUES(updated_at)`,
    [profileId, streak, streak, today, unclaimed, continues ? Number(row.lost_unclaimed || 0) : lost]);
  return { counted: true, added, lost };
}

/** The app was opened: count today for this profile. { counted, added, lost, ...streak view } */
async function checkIn(profileId, now = new Date(), c = null) {
  const go = async (cc) => {
    await lockProfile(cc, profileId);
    const { amounts } = await getAmounts(cc);
    const r = await countToday(cc, profileId, now, amounts);
    return { ...r, ...view(await loadRow(cc, profileId), etDate(now), amounts) };
  };
  return c ? go(c) : tx(go);
}

/**
 * Claim the unclaimed bonus (counts today first: claiming means the app is open). Same transactionId again → the first
 * result (duplicate: true). Nothing to claim → 409 NOTHING_TO_CLAIM.
 */
async function claim(profileId, transactionId, now = new Date()) {
  const txId = sparks.normalizeTxId(transactionId);
  return tx(async (c) => {
    await lockProfile(c, profileId);
    const { amounts } = await getAmounts(c);
    const prior = (await c.query('SELECT * FROM sparks_transactions WHERE transaction_id = ?', [txId]))[0];
    if (prior) {
      if (Number(prior.profile_id) !== Number(profileId) || prior.type !== 'streak') {
        throw conflict('TRANSACTION_ID_CONFLICT', 'This transactionId was already used for a different Sparks transaction');
      }
      return { duplicate: true, claimed: Number(prior.amount), transactionId: txId, balance: await sparks.getBalance(profileId, c),
        ...view(await loadRow(c, profileId), etDate(now), amounts) };
    }
    await countToday(c, profileId, now, amounts);
    const row = await loadRow(c, profileId);
    const amount = Number(row.unclaimed);
    if (amount <= 0) throw conflict('NOTHING_TO_CLAIM', 'There is no Streak Bonus to claim');
    const r = await sparks.credit({ profileId, amount, type: 'streak', transactionId: txId, reference: `streak:day:${row.current_streak}` }, c);
    await c.query('UPDATE profile_streaks SET unclaimed = 0, last_claimed_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP() WHERE profile_id = ?', [profileId]);
    return { duplicate: false, claimed: amount, transactionId: txId, balance: r.balance, ...view(await loadRow(c, profileId), etDate(now), amounts) };
  });
}

module.exports = { MAX_DAYS, MAX_DAY_SPARKS, DEFAULT_AMOUNTS, dayBefore, getAmounts, setAmounts, getStreak, checkIn, claim };
