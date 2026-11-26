const { query } = require('../db');
const { ageGroupForDob } = require('./ageGroup');

/** Public-safe view. dob and country are included only when `own` is true (never shown to other users). */
function profileView(p, { own = false } = {}) {
  const v = {
    id: p.id, username: p.username, avatarId: p.avatar_id, ageGroup: p.age_group,
    isChild: !!p.is_child, language: p.language, contentLanguage: p.content_language || p.language, mode: p.mode, createdAt: p.created_at,
  };
  if (own) {
    v.dob = p.dob;
    v.country = p.country ?? null;
    v.studentStatus = p.student_status || 'not_asked';
    // Sparks this profile received for its student status (verified / interest confirmed). Since Milestone 2 they are
    // credited to the Sparks ledger (the name is kept for the app). Own account only, like studentStatus.
    v.studentSparksReserved = Number(p.student_sparks_awarded || 0);
    // Current spendable Sparks of THIS profile (never pooled across a parent account). Set by withSparks().
    v.sparksBalance = Number(p.sparks_balance || 0);
  }
  return v;
}

/** Adds sparks_balance (profile_sparks.balance) to profile rows, in place. Returns the rows. */
async function withSparks(rows) {
  const list = Array.isArray(rows) ? rows : [rows];
  const ids = list.filter(Boolean).map((p) => p.id);
  if (!ids.length) return rows;
  const bal = await query(`SELECT profile_id, balance FROM profile_sparks WHERE profile_id IN (${ids.map(() => '?').join(',')})`, ids);
  const by = new Map(bal.map((r) => [Number(r.profile_id), Number(r.balance)]));
  for (const p of list) if (p) p.sparks_balance = by.get(Number(p.id)) || 0;
  return rows;
}

/** One profile row (with its Sparks balance), or undefined. */
async function profileById(id) {
  const p = (await query('SELECT * FROM profiles WHERE id = ?', [id]))[0];
  return p ? withSparks(p) : p;
}

/** Effective age group: admin override wins, otherwise derived from DOB today (Eastern Time). */
const effectiveAgeGroup = (p) => p.age_group_override || ageGroupForDob(p.dob);

/** Load an account's profiles, refreshing stored age groups that have changed (birthdays). */
async function loadProfiles(accountId) {
  const rows = await query('SELECT * FROM profiles WHERE account_id = ? ORDER BY id', [accountId]);
  for (const p of rows) {
    const ag = effectiveAgeGroup(p);
    if (ag && ag !== p.age_group) {
      await query('UPDATE profiles SET age_group = ? WHERE id = ?', [ag, p.id]);
      p.age_group = ag;
    }
  }
  return withSparks(rows);
}

/** Recompute stored age groups for every profile. Run daily (cron) so leaderboards stay correct. */
async function refreshAllAgeGroups() {
  const rows = await query('SELECT id, dob, age_group, age_group_override FROM profiles');
  let changed = 0;
  for (const p of rows) {
    const ag = effectiveAgeGroup(p);
    if (ag && ag !== p.age_group) { await query('UPDATE profiles SET age_group = ? WHERE id = ?', [ag, p.id]); changed++; }
  }
  return changed;
}

const accountView = (a) => ({
  id: a.id, email: a.email, accountType: a.account_type, phone: a.phone, language: a.preferred_language,
  emailVerified: !!a.email_verified_at, parentPinSet: !!a.parent_pin_hash,
});

module.exports = { profileView, withSparks, profileById, effectiveAgeGroup, loadProfiles, refreshAllAgeGroups, accountView };
