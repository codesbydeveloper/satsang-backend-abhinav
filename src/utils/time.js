// Server time is authoritative. Streaks, daily challenges and daily/weekly leaderboard
// resets use America/New_York (DST-aware); the Daily Spin is a rolling 24h timer (not date based).
const TZ = 'America/New_York';

const nowUtc = () => new Date();

/** "YYYY-MM-DD HH:MM:SS" in UTC, for MySQL DATETIME columns. */
function toSql(d = new Date()) {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
function fromSql(s) {
  return s ? new Date(String(s).replace(' ', 'T') + 'Z') : null;
}
/** A MySQL DATETIME string ("YYYY-MM-DD HH:MM:SS", stored in UTC) as ISO 8601 UTC ("...T...Z"); anything else unchanged. */
const SQL_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/;
function toIso(s) {
  return typeof s === 'string' && SQL_DATETIME.test(s) ? fromSql(s).toISOString() : s;
}

/**
 * JSON replacer for every API response (app.set('json replacer')): timestamp fields (keys ending in At / _at /
 * Until / _until) that hold a DATETIME string are sent as ISO UTC ("2026-11-19T12:02:37.000Z"), so clients never
 * have to guess the zone. Dates without a time (dob, game days) stay "YYYY-MM-DD".
 */
const TIMESTAMP_KEY = /(At|_at|Until|_until)$/;
function jsonTimestamps(key, value) {
  return TIMESTAMP_KEY.test(key) ? toIso(value) : value;
}

function addMinutes(d, m) { return new Date(d.getTime() + m * 60000); }
function addDays(d, n) { return new Date(d.getTime() + n * 86400000); }

/** Calendar date (YYYY-MM-DD) of an instant in Eastern Time — the "game day". */
function etDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

module.exports = { TZ, nowUtc, toSql, fromSql, toIso, jsonTimestamps, addMinutes, addDays, etDate };
