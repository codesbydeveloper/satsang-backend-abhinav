const { query } = require('../db');
const { ageGroupForDob } = require('./ageGroup');

/** Public-safe view. dob is included only when `own` is true (never shown to other users). */
function profileView(p, { own = false } = {}) {
  const v = {
    id: p.id, username: p.username, avatarId: p.avatar_id, ageGroup: p.age_group,
    isChild: !!p.is_child, language: p.language, mode: p.mode, createdAt: p.created_at,
  };
  if (own) v.dob = p.dob;
  return v;
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
  return rows;
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

module.exports = { profileView, effectiveAgeGroup, loadProfiles, refreshAllAgeGroups, accountView };
