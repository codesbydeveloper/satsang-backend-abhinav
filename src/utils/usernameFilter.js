const { query } = require('../db');

// Letters/marks from any script (covers Gujarati), digits, underscore, dot. 3–20 characters.
const USERNAME_RE = /^[\p{L}\p{M}\p{N}_.]{3,20}$/u;

const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '!': 'i' };

/** Normalise for matching: NFC, lowercase, undo common letter-for-digit swaps, drop separators. */
function normalise(s) {
  return s.normalize('NFC').toLowerCase()
    .replace(/[0134577@$!]/g, (c) => LEET[c])
    .replace(/[_.\-\s]/g, '');
}

function lowerKey(username) { return username.normalize('NFC').toLowerCase(); }

/**
 * Check a username. Returns { ok: true } or { ok: false, reason }.
 * reason is one of: INVALID_FORMAT | BLOCKED_WORD | RESERVED | TAKEN
 */
async function checkUsername(username, { excludeProfileId = null } = {}) {
  const name = username.normalize('NFC');
  if (!USERNAME_RE.test(name)) return { ok: false, reason: 'INVALID_FORMAT' };

  const norm = normalise(name);
  const words = await query('SELECT word, kind FROM blocked_words');
  for (const { word, kind } of words) {
    const w = normalise(word);
    if (!w) continue;
    // reserved names block an exact match; blocked words block when they appear anywhere
    if (kind === 'reserved' ? norm === w : norm.includes(w)) {
      return { ok: false, reason: kind === 'reserved' ? 'RESERVED' : 'BLOCKED_WORD' };
    }
  }

  const rows = await query(
    'SELECT id FROM profiles WHERE username_lower = ?' + (excludeProfileId ? ' AND id <> ?' : '') + ' LIMIT 1',
    excludeProfileId ? [lowerKey(name), excludeProfileId] : [lowerKey(name)],
  );
  if (rows.length) return { ok: false, reason: 'TAKEN' };
  return { ok: true };
}

module.exports = { USERNAME_RE, normalise, lowerKey, checkUsername };
