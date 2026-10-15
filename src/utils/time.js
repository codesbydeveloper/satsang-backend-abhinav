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
function addMinutes(d, m) { return new Date(d.getTime() + m * 60000); }
function addDays(d, n) { return new Date(d.getTime() + n * 86400000); }

/** Calendar date (YYYY-MM-DD) of an instant in Eastern Time — the "game day". */
function etDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

module.exports = { TZ, nowUtc, toSql, fromSql, addMinutes, addDays, etDate };
