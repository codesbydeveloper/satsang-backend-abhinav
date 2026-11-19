// Erase deleted accounts' emails kept past RETAINED_EMAIL_DAYS. The server also does this on start and every
// 24 hours; this one-off run is for a cPanel cron job:
//   npm run purge:retained-emails
const { pool } = require('../src/db');
const { purgeRetainedEmails } = require('../src/utils/retainedEmails');

purgeRetainedEmails()
  .then(async (n) => { console.log(`Erased ${n} retained email(s).`); await pool.end(); })
  .catch(async (e) => { console.error('Purge failed:', e.message); await pool.end().catch(() => {}); process.exit(1); });
