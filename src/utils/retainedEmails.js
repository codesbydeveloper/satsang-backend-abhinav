const { query } = require('../db');
const { audit } = require('./audit');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Erase deleted accounts' emails whose retention period is over (email_retained_until < now). Runs on server
 * start, every 24 hours, and from `npm run purge:retained-emails` (cPanel cron). When anything was erased an
 * audit row (retained_emails.purged) records the count only.
 * @returns {Promise<number>} how many emails were erased
 */
async function purgeRetainedEmails() {
  const r = await query(
    'UPDATE account_deletion_requests SET email_retained = NULL WHERE email_retained IS NOT NULL AND email_retained_until < UTC_TIMESTAMP()');
  const purged = r.affectedRows || 0;
  if (purged) await audit({}, 'retained_emails.purged', { entityType: 'deletion_request', details: { count: purged } });
  return purged;
}

/** Run the purge now and every 24 hours. The timer is unref'd so it never keeps the process alive. */
function schedulePurge() {
  const run = () => purgeRetainedEmails().catch((e) => console.error('retained-email purge failed:', e.message));
  run();
  return setInterval(run, DAY_MS).unref();
}

module.exports = { purgeRetainedEmails, schedulePurge };
