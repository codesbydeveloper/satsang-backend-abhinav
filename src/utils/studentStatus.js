const config = require('../config');
const { badRequest, conflict, notFound } = require('./errors');

/**
 * Student status (Loyadham Online Classes: Bals-Balikas or Kishor-Kishori Classes), client 21 Nov 2026.
 * One status per playable profile (an independent account's own profile, each child profile separately).
 *
 * App (PUT /profiles/:id/student-status):
 *   enrolled true                  → pending_verification
 *   enrolled false, interested true  → interested
 *   enrolled false, interested false → not_enrolled
 *   locked once verified or interest_confirmed (409 STUDENT_STATUS_LOCKED).
 * Full Admin (POST /admin/profiles/:id/student-status):
 *   verify           pending_verification → verified            +STUDENT_VERIFIED_SPARKS
 *   confirm_interest interested           → interest_confirmed  +STUDENT_INTEREST_SPARKS
 *   reject           pending_verification → not_enrolled        no Sparks
 *   reset            any (except not_asked) → not_asked          no Sparks taken back
 *
 * Sparks belong to that exact profile. There is no Sparks ledger before Milestone 2, so (like the sign-up bonus,
 * referrals and Explore imports) the reward is reserved in profile_sparks_rewards and credited by the ledger later.
 * Each reward is given at most once per profile (unique key), so reset + verify again never pays twice.
 */

const STUDENT_STATUSES = ['not_asked', 'pending_verification', 'verified', 'interested', 'interest_confirmed', 'not_enrolled'];
const LOCKED = new Set(['verified', 'interest_confirmed']);
const ADMIN_ACTIONS = ['verify', 'reject', 'confirm_interest', 'reset'];

/** Reward amounts from config (STUDENT_VERIFIED_SPARKS, STUDENT_INTEREST_SPARKS). */
const studentSparks = () => ({ verified: config.studentVerifiedSparks, interestConfirmed: config.studentInterestSparks });

/** The app's answer → the new status. */
function statusFromAnswer({ enrolled, interested }) {
  if (enrolled) return 'pending_verification';
  if (interested === undefined) throw badRequest('INTERESTED_REQUIRED', 'Say whether you are interested in joining the classes');
  return interested ? 'interested' : 'not_enrolled';
}

/** Admin action: { from (allowed current statuses, null = any but not_asked), to, reward?, audit }. */
const TRANSITIONS = {
  verify: { from: ['pending_verification'], to: 'verified', reward: 'student_verified', audit: 'student.verified' },
  confirm_interest: { from: ['interested'], to: 'interest_confirmed', reward: 'student_interest_confirmed', audit: 'student.interest_confirmed' },
  reject: { from: ['pending_verification'], to: 'not_enrolled', audit: 'student.rejected' },
  reset: { from: null, to: 'not_asked', audit: 'student.reset' },
};

const rewardAmount = (reward) => (reward === 'student_verified' ? config.studentVerifiedSparks : config.studentInterestSparks);

/**
 * The app sets its own answer. Call inside tx(); the caller has already checked the profile belongs to the account.
 * @returns {{ from: string, to: string }}
 */
async function setStudentStatusByUser(c, profileId, answer) {
  const p = (await c.query('SELECT id, student_status FROM profiles WHERE id = ? FOR UPDATE', [profileId]))[0];
  if (!p) throw notFound('PROFILE_NOT_FOUND', 'Profile not found');
  if (LOCKED.has(p.student_status)) throw conflict('STUDENT_STATUS_LOCKED', 'This student status has been confirmed and can no longer be changed');
  const to = statusFromAnswer(answer);
  await c.query('UPDATE profiles SET student_status = ?, student_status_updated_at = UTC_TIMESTAMP() WHERE id = ?', [to, p.id]);
  return { from: p.student_status, to };
}

/**
 * A Full Admin acts on a profile's status. Call inside tx(): the profile row is locked, so two admins clicking
 * "verify" at once give the Sparks once.
 * @returns {{ from, to, auditAction, sparksAwarded, studentSparksAwarded }}
 */
async function applyAdminAction(c, profileId, action, adminId) {
  const t = TRANSITIONS[action];
  const p = (await c.query('SELECT id, student_status, student_sparks_awarded FROM profiles WHERE id = ? FOR UPDATE', [profileId]))[0];
  if (!p) throw notFound('PROFILE_NOT_FOUND', 'Profile not found');
  const allowed = t.from ? t.from.includes(p.student_status) : p.student_status !== 'not_asked';
  if (!allowed) {
    throw conflict('INVALID_STUDENT_TRANSITION', `Cannot ${action.replace('_', ' ')} a profile whose student status is ${p.student_status}`);
  }

  let sparksAwarded = 0;
  if (t.reward) {
    const amount = rewardAmount(t.reward);
    const r = await c.query(
      'INSERT IGNORE INTO profile_sparks_rewards (profile_id, reward, sparks, tx_id, awarded_by) VALUES (?,?,?,?,?)',
      [p.id, t.reward, amount, `${t.reward}-${p.id}`, adminId]);
    if (r.affectedRows) sparksAwarded = amount;   // 0 when this reward was already given (e.g. after a reset)
  }

  if (action === 'reset') {
    await c.query(
      `UPDATE profiles SET student_status = 'not_asked', student_status_updated_at = UTC_TIMESTAMP(),
              student_verified_by = NULL, student_verified_at = NULL WHERE id = ?`, [p.id]);
  } else if (t.reward) {
    await c.query(
      `UPDATE profiles SET student_status = ?, student_status_updated_at = UTC_TIMESTAMP(), student_verified_by = ?,
              student_verified_at = UTC_TIMESTAMP(), student_sparks_awarded = student_sparks_awarded + ? WHERE id = ?`,
      [t.to, adminId, sparksAwarded, p.id]);
  } else {
    await c.query('UPDATE profiles SET student_status = ?, student_status_updated_at = UTC_TIMESTAMP() WHERE id = ?', [t.to, p.id]);
  }
  return { from: p.student_status, to: t.to, auditAction: t.audit, sparksAwarded, studentSparksAwarded: p.student_sparks_awarded + sparksAwarded };
}

module.exports = { STUDENT_STATUSES, ADMIN_ACTIONS, LOCKED, studentSparks, statusFromAnswer, setStudentStatusByUser, applyAdminAction };
