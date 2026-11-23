const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { api, bearer, outbox } = h;
const mailer = require('../src/utils/mailer');
const { purgeRetainedEmails } = require('../src/utils/retainedEmails');
const { emailFor } = require('../src/routes/admin/deletionRequests');

beforeEach(h.resetDb);
after(() => h.pool.end());

const URL = '/api/v1/admin/deletion-requests';
const SUBJECT = '🙏 Satsang Spark – Account Deletion Confirmation';
const deletedMails = (to) => outbox.filter((m) => m.to === to && m.subject === SUBJECT);
const deleteInApp = (token) => api().delete('/api/v1/me').set(bearer(token)).send({ password: 'Secret123', confirm: true });
const daysFromNow = (s) => (new Date(s.replace(' ', 'T') + 'Z') - Date.now()) / 86400000;

test('deleting in the app emails the owner a confirmation (text + html, no personal data)', async () => {
  const adult = await h.adultLogin('ravi@example.org', 'ravi_k');
  const del = await deleteInApp(adult.accessToken);
  assert.equal(del.status, 200);
  const mails = deletedMails('ravi@example.org');
  assert.equal(mails.length, 1);
  assert.match(mails[0].text, /Your Satsang Spark account has been successfully deleted\./);
  assert.match(mails[0].html, /^<!doctype html>/);
  assert.match(mails[0].html, /<p[^>]*>Your Satsang Spark account has been successfully deleted\.<\/p>/);
  assert.ok(!/ravi_k|Ravi|Kumar/.test(mails[0].text + mails[0].html), 'no username or name in the email');
});

test('a parent account approved from the web page: the email goes to the parent', async () => {
  const b = await h.adminLogin(await h.makeAdmin('boss@example.org'));
  const parent = await h.parentLogin('parent@example.org');
  await api().post('/api/v1/profiles').set(parent.auth).send({ pin: '1234', username: 'kid_one', avatarId: 2, dob: h.dobYearsAgo(8), parentalConsent: true });
  const req = (await api().post('/api/v1/public/delete-account').send({ email: 'parent@example.org', password: 'Secret123', confirm: true })).body;
  assert.equal(deletedMails('parent@example.org').length, 0, 'nothing sent while the request is only pending');
  const r = await api().post(`${URL}/${req.requestId}/approve`).set(bearer(b.token)).send({ confirm: true });
  assert.equal(r.status, 200);
  assert.equal(deletedMails('parent@example.org').length, 1);
  assert.equal(outbox.filter((m) => m.subject === SUBJECT).length, 1, 'one email only, none for child profiles');
});

test('the deletion still completes when the confirmation email fails', async () => {
  const adult = await h.adultLogin('ravi@example.org', 'ravi_k');
  const original = mailer.sendAccountDeletedEmail;
  const originalError = console.error;
  const logged = [];
  mailer.sendAccountDeletedEmail = async () => { throw new Error('SMTP down'); };
  console.error = (...a) => logged.push(a.join(' '));
  try {
    const del = await deleteInApp(adult.accessToken);
    assert.equal(del.status, 200);
    assert.deepEqual(del.body, { deleted: true, profilesDeleted: 1 });
  } finally {
    mailer.sendAccountDeletedEmail = original;
    console.error = originalError;
  }
  assert.equal((await h.query('SELECT COUNT(*) n FROM accounts WHERE id = ?', [adult.account.id]))[0].n, 0);
  assert.ok(logged.some((l) => l.includes('account-deleted email failed') && l.includes('SMTP down')));
  assert.ok(!logged.some((l) => l.includes('ravi@example.org')), 'the address is not logged');
  const row = (await h.query('SELECT status, email_retained FROM account_deletion_requests WHERE account_id = ?', [adult.account.id]))[0];
  assert.equal(row.status, 'completed');
  assert.equal(row.email_retained, 'ravi@example.org');
});

test('Full Admin sees the retained email for 30 days on list and detail; nothing else personal is kept', async () => {
  const b = await h.adminLogin(await h.makeAdmin('boss@example.org'));
  const adult = await h.adultLogin('ravi@example.org', 'ravi_k');
  await deleteInApp(adult.accessToken);

  const db = (await h.query('SELECT * FROM account_deletion_requests WHERE account_id = ?', [adult.account.id]))[0];
  assert.equal(db.email_retained, 'ravi@example.org');
  assert.ok(Math.abs(daysFromNow(db.email_retained_until) - 30) < 0.01, `until ≈ now + 30 days, got ${db.email_retained_until}`);
  assert.equal(db.username_retained, 'ravi_k');   // username kept for the same period (23 Nov 2026)
  const { username_retained: _u, ...others } = db;
  assert.ok(!JSON.stringify(others).match(/ravi_k|Ravi|Kumar/), 'no other username copy and no name on the row');

  const l = await api().get(URL).set(bearer(b.token)).query({ status: 'completed' });
  assert.equal(l.body.rows[0].email, 'ravi@example.org');
  assert.equal(l.body.rows[0].emailRetainedUntil, db.email_retained_until.replace(' ', 'T') + '.000Z', 'ISO UTC');
  assert.equal(l.body.rows[0].username, 'ravi_k');
  const v = await api().get(`${URL}/${db.id}`).set(bearer(b.token));
  assert.equal(v.body.request.email, 'ravi@example.org');
  assert.equal(v.body.account, null);
});

test('Content Editors never see the email', async () => {
  const adult = await h.adultLogin('ravi@example.org', 'ravi_k');
  await deleteInApp(adult.accessToken);
  const id = (await h.query('SELECT id FROM account_deletion_requests'))[0].id;
  const ed = await h.adminLogin(await h.makeAdmin('editor@example.org', 'content_editor'));
  const l = await api().get(URL).set(bearer(ed.token)).query({ status: 'completed' });
  assert.equal(l.status, 403);
  assert.ok(!JSON.stringify(l.body).includes('ravi@example.org'));
  assert.equal((await api().get(`${URL}/${id}`).set(bearer(ed.token))).status, 403);

  // and the row mapper itself returns null for any role but Full Admin
  const r = { status: 'completed', email_retained: 'ravi@example.org', retained_live: 1 };
  assert.equal(emailFor(r, { role: 'content_editor' }), null);
  assert.equal(emailFor(r, null), null);
  assert.equal(emailFor(r, { role: 'full_admin' }), 'ravi@example.org');
});

test('the email is hidden once email_retained_until has passed, even before the purge runs', async () => {
  const b = await h.adminLogin(await h.makeAdmin('boss@example.org'));
  const adult = await h.adultLogin('ravi@example.org', 'ravi_k');
  await deleteInApp(adult.accessToken);
  await h.query('UPDATE account_deletion_requests SET email_retained_until = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE)');
  const l = await api().get(URL).set(bearer(b.token)).query({ status: 'completed' });
  assert.equal(l.body.rows[0].email, null);
  assert.ok(Date.parse(l.body.rows[0].emailRetainedUntil) < Date.now(), 'the past cut-off is still sent, so the panel can show "erased"');
  const id = l.body.rows[0].id;
  assert.equal((await api().get(`${URL}/${id}`).set(bearer(b.token))).body.request.email, null);
});

test('purge erases expired retained emails only and audits the count', async () => {
  const old = await h.adultLogin('old@example.org', 'old_one');
  const fresh = await h.adultLogin('fresh@example.org', 'fresh_one');
  await deleteInApp(old.accessToken);
  await deleteInApp(fresh.accessToken);
  await h.query('UPDATE account_deletion_requests SET email_retained_until = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 31 DAY) WHERE account_id = ?', [old.account.id]);

  assert.equal(await purgeRetainedEmails(), 1);
  const rows = await h.query('SELECT account_id, email_retained FROM account_deletion_requests ORDER BY id');
  assert.equal(rows.find((r) => r.account_id === old.account.id).email_retained, null);
  assert.equal(rows.find((r) => r.account_id === fresh.account.id).email_retained, 'fresh@example.org');

  const log = await h.query("SELECT * FROM audit_log WHERE action = 'retained_emails.purged'");
  assert.equal(log.length, 1);
  assert.deepEqual(log[0].details, { count: 1 });
  assert.equal(log[0].admin_id, null);

  assert.equal(await purgeRetainedEmails(), 0, 'nothing left to erase');
  assert.equal((await h.query("SELECT COUNT(*) n FROM audit_log WHERE action = 'retained_emails.purged'"))[0].n, 1, 'no audit row when nothing was erased');
});

test('search: a Full Admin finds a completed row by its retained email, only until it is erased', async () => {
  const b = await h.adminLogin(await h.makeAdmin('boss@example.org'));
  const adult = await h.adultLogin('ravi@example.org', 'ravi_k');
  await deleteInApp(adult.accessToken);
  await h.adultLogin('other@example.org', 'other_one');
  await api().post('/api/v1/public/delete-account').send({ email: 'other@example.org', password: 'Secret123', confirm: true });

  const find = (q) => api().get(URL).set(bearer(b.token)).query({ status: 'all', q });
  let l = await find('ravi@');
  assert.equal(l.status, 200);
  assert.deepEqual(l.body.rows.map((r) => [r.status, r.email]), [['completed', 'ravi@example.org']]);
  assert.deepEqual(l.body.counts, { pending: 0, completed: 1, rejected: 0, all: 1 });
  l = await find('other@');
  assert.deepEqual(l.body.rows.map((r) => [r.status, r.email]), [['pending', 'other@example.org']], 'live emails still match');
  l = await find('ravi_k');
  assert.deepEqual(l.body.rows.map((r) => [r.status, r.username]), [['completed', 'ravi_k']], 'the retained username matches too');

  await h.query('UPDATE account_deletion_requests SET email_retained_until = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE) WHERE account_id = ?', [adult.account.id]);
  l = await find('ravi@');
  assert.equal(l.body.rows.length, 0, 'not searchable once past email_retained_until, even before the purge');
  assert.equal(l.body.counts.all, 0);
  assert.equal((await find('ravi_k')).body.rows.length, 0, 'nor by the username');
});
