const crypto = require('crypto');
const { query } = require('../db');
const { sha256, randomToken, signAccessToken } = require('./tokens');
const { toSql, addDays } = require('./time');
const config = require('../config');
const { accountView, profileView, loadProfiles } = require('./profiles');

/**
 * Create a new refresh token. If sessionId is given the token continues that device session
 * (rotation); otherwise a new session starts.
 */
async function createRefresh(accountId, { sessionId = crypto.randomBytes(16).toString('hex'), profileId = null } = {}) {
  const raw = randomToken();
  await query('INSERT INTO refresh_tokens (account_id, session_id, profile_id, token_hash, expires_at) VALUES (?,?,?,?,?)',
    [accountId, sessionId, profileId, sha256(raw), toSql(addDays(new Date(), config.refreshTokenDays))]);
  return { raw, sessionId };
}

/** Start a login session. Adults are placed in their own profile; parents start in parent mode. */
async function startSession(account) {
  const profiles = await loadProfiles(account.id);
  const activeProfileId = account.account_type === 'adult' && profiles[0] ? profiles[0].id : null;
  const { raw, sessionId } = await createRefresh(account.id, { profileId: activeProfileId });
  return buildAuthResponse(account, profiles, activeProfileId, raw, sessionId);
}

function buildAuthResponse(account, profiles, activeProfileId, refreshToken, sessionId) {
  return {
    accessToken: signAccessToken(account, activeProfileId, sessionId),
    refreshToken,
    account: accountView(account),
    profiles: profiles.map((p) => profileView(p, { own: true })),
    activeProfileId,
  };
}

module.exports = { createRefresh, startSession, buildAuthResponse };
