// Milestone 2, chunk 2.1: Sparks Economy core ledger (contract 8.1) — ledger, balances, history, reward config.
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const h = require('./helpers');
const { api, bearer } = h;
const sparks = require('../src/services/sparks');
const R = require('../src/utils/referrals');
const config = require('../src/config');

beforeEach(h.resetDb);
after(() => h.pool.end());

async function adult(email = 'ravi@example.org', username = 'ravi_k') {
  const b = await h.adultLogin(email, username);
  return { auth: bearer(b.accessToken), profileId: b.profiles[0].id, accountId: b.account.id };
}
const addChild = (p, username) => api().post('/api/v1/profiles').set(p.auth)
  .send({ username, avatarId: 2, dob: h.dobYearsAgo(9, 30), parentalConsent: true, pin: '1234' });
const balanceRow = async (id) => (await h.query('SELECT balance, lifetime_earned, lifetime_spent, pending FROM profile_sparks WHERE profile_id = ?', [id]))[0];
const ledger = (id) => h.query('SELECT type, amount, status, transaction_id FROM sparks_transactions WHERE profile_id = ? ORDER BY id', [id]);
const auditRows = (action) => h.query('SELECT * FROM audit_log WHERE action = ? ORDER BY id', [action]);
const details = (row) => (typeof row.details === 'string' ? JSON.parse(row.details) : row.details);

/** The balance row always equals the ledger (the invariant migration 020 recomputes). */
async function assertConsistent(profileId) {
  const t = (await h.query(
    `SELECT COALESCE(SUM(CASE WHEN status = 'verified' THEN amount END), 0) AS balance,
            COALESCE(SUM(CASE WHEN status = 'verified' AND NOT (amount < 0 AND type <> 'admin_adjust') THEN amount END), 0) AS earned,
            COALESCE(SUM(CASE WHEN status = 'verified' AND amount < 0 AND type <> 'admin_adjust' THEN -amount END), 0) AS spent,
            COALESCE(SUM(CASE WHEN status = 'pending' THEN amount END), 0) AS pending
     FROM sparks_transactions WHERE profile_id = ?`, [profileId]))[0];
  const b = await sparks.getBalance(profileId);
  assert.deepEqual(b, { balance: Number(t.balance), lifetimeEarned: Number(t.earned), lifetimeSpent: Number(t.spent), pending: Number(t.pending) });
}

test('sign-up: 100 Sparks credited to the independent profile once; sparksBalance in every own profile response', async () => {
  const a = await adult();
  assert.deepEqual(await ledger(a.profileId), [{ type: 'signup_bonus', amount: 100, status: 'verified', transaction_id: `signup_bonus-account-${a.accountId}` }]);
  const r = await api().get(`/api/v1/profiles/${a.profileId}/sparks`).set(a.auth);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { profileId: a.profileId, balance: 100, lifetimeEarned: 100, lifetimeSpent: 0, pending: 0 });
  const me = await api().get('/api/v1/me').set(a.auth);
  assert.equal(me.body.profiles[0].sparksBalance, 100);
  assert.deepEqual(me.body.account.signupBonus, { sparks: 100, status: 'credited' });
  assert.equal((await api().get('/api/v1/profiles').set(a.auth)).body.profiles[0].sparksBalance, 100);
  const login = await api().post('/api/v1/auth/login').send({ email: 'ravi@example.org', password: 'Secret123' });
  assert.equal(login.body.profiles[0].sparksBalance, 100);
  assert.equal((await ledger(a.profileId)).length, 1, 'login never pays again');
});

test('idempotency: the same transactionId twice is processed once; reused for something else → 409', async () => {
  const a = await adult();
  const o = { profileId: a.profileId, amount: 20, type: 'quiz', transactionId: 'B5C1A6E2-1111-4c2e-9a77-0f3f2d1e0a01', reference: 'attempt:1' };
  const first = await sparks.credit(o);
  assert.equal(first.duplicate, false);
  assert.equal(first.balance.balance, 120);
  const again = await sparks.credit(o);
  assert.equal(again.duplicate, true);
  assert.equal(again.transaction.id, first.transaction.id);
  assert.equal(again.balance.balance, 120);
  assert.equal(first.transaction.transaction_id, o.transactionId.toLowerCase(), 'stored lower case');
  assert.equal((await sparks.credit({ ...o, transactionId: o.transactionId.toLowerCase() })).duplicate, true, 'case does not matter');

  await assert.rejects(sparks.credit({ ...o, amount: 25 }), (e) => e.code === 'TRANSACTION_ID_CONFLICT');
  const b = await adult('b@example.org', 'bina_b');
  await assert.rejects(sparks.credit({ ...o, profileId: b.profileId }), (e) => e.code === 'TRANSACTION_ID_CONFLICT');
  await assert.rejects(sparks.spend({ profileId: a.profileId, amount: 20, transactionId: o.transactionId }), (e) => e.code === 'TRANSACTION_ID_CONFLICT');
  assert.equal((await sparks.getBalance(b.profileId)).balance, 100);
  // a spend retried after a lost response: duplicate, not a second charge
  const s = { profileId: a.profileId, amount: 50, transactionId: 'purchase-crown-1', reference: 'item:crown' };
  assert.equal((await sparks.spend(s)).duplicate, false);
  assert.equal((await sparks.spend(s)).duplicate, true);
  assert.equal((await sparks.getBalance(a.profileId)).balance, 70);
  await assertConsistent(a.profileId);
});

test('the balance never goes below zero: 409 INSUFFICIENT_SPARKS and nothing is written', async () => {
  const a = await adult();
  await assert.rejects(sparks.spend({ profileId: a.profileId, amount: 101, transactionId: 'too-much' }),
    (e) => e.status === 409 && e.code === 'INSUFFICIENT_SPARKS' && e.details.balance === 100 && e.details.needed === 101);
  assert.equal((await h.query("SELECT COUNT(*) n FROM sparks_transactions WHERE transaction_id = 'too-much'"))[0].n, 0);
  assert.equal((await sparks.spend({ profileId: a.profileId, amount: 100, transactionId: 'all-of-it' })).balance.balance, 0);
  await assert.rejects(sparks.spend({ profileId: a.profileId, amount: 1, transactionId: 'one-more' }), (e) => e.code === 'INSUFFICIENT_SPARKS');
  await assert.rejects(sparks.credit({ profileId: a.profileId, amount: -5, type: 'quiz' }), (e) => e.code === 'INVALID_AMOUNT');
  await assert.rejects(sparks.credit({ profileId: a.profileId, amount: 5, type: 'purchase' }), (e) => e.code === 'INVALID_SPARKS_TYPE');
  await assert.rejects(sparks.credit({ profileId: 999999, amount: 5, type: 'quiz' }), (e) => e.code === 'PROFILE_NOT_FOUND');
  assert.deepEqual(await balanceRow(a.profileId), { balance: 0, lifetime_earned: 100, lifetime_spent: 100, pending: 0 });
});

test('concurrent spends: the row lock lets exactly as many through as the balance allows', async () => {
  const a = await adult();   // 100
  const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) =>
    sparks.spend({ profileId: a.profileId, amount: 30, transactionId: `concurrent-${i}` })));
  const ok = results.filter((r) => r.status === 'fulfilled');
  const refused = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 3);
  assert.equal(refused.length, 7);
  for (const r of refused) assert.equal(r.reason.code, 'INSUFFICIENT_SPARKS');
  assert.deepEqual(await sparks.getBalance(a.profileId), { balance: 10, lifetimeEarned: 100, lifetimeSpent: 90, pending: 0 });

  // the same transaction id sent in parallel (a double tap) is charged once
  await sparks.credit({ profileId: a.profileId, amount: 90, type: 'game', transactionId: 'refill' });
  const twins = await Promise.all(Array.from({ length: 5 }, () => sparks.spend({ profileId: a.profileId, amount: 40, transactionId: 'double-tap' })));
  assert.equal(twins.filter((r) => !r.duplicate).length, 1);
  assert.equal((await sparks.getBalance(a.profileId)).balance, 60);
  await assertConsistent(a.profileId);
});

test('per-profile isolation: a parent account never pools Sparks; each child has its own balance and history', async () => {
  const p = await h.parentLogin();
  assert.equal((await h.query('SELECT status FROM signup_bonuses'))[0].status, 'pending', 'no profile yet');
  const kid1 = (await addChild(p, 'kid_one')).body.profile;
  assert.equal(kid1.sparksBalance, 100, 'the first child receives the account sign-up bonus');
  const kid2 = (await addChild(p, 'kid_two')).body.profile;
  assert.equal(kid2.sparksBalance, 0, 'and only once');
  await sparks.credit({ profileId: kid2.id, amount: 7, type: 'puzzle' });

  const b1 = await api().get(`/api/v1/profiles/${kid1.id}/sparks`).set(p.auth);
  const b2 = await api().get(`/api/v1/profiles/${kid2.id}/sparks`).set(p.auth);
  assert.equal(b1.body.balance, 100);
  assert.equal(b2.body.balance, 7);
  const hist2 = await api().get(`/api/v1/profiles/${kid2.id}/sparks/history`).set(p.auth);
  assert.deepEqual(hist2.body.items.map((t) => [t.type, t.amount]), [['puzzle', 7]]);
  assert.equal(hist2.body.items[0].createdBy, undefined, 'no admin fields in the app');
  const report = await api().get('/api/v1/parent/report').set(p.auth);
  assert.deepEqual(report.body.children.map((c) => c.sparks.balance), [100, 7]);

  // a child's session sees only itself
  const sw = await api().post(`/api/v1/profiles/${kid1.id}/switch`).set(p.auth).send({ pin: '1234' });
  assert.equal(sw.body.profile.sparksBalance, 100);
  const kidAuth = bearer(sw.body.accessToken);
  assert.equal((await api().get(`/api/v1/profiles/${kid1.id}/sparks`).set(kidAuth)).status, 200);
  const sib = await api().get(`/api/v1/profiles/${kid2.id}/sparks`).set(kidAuth);
  assert.equal(sib.status, 403); assert.equal(sib.body.error.code, 'PARENT_MODE_REQUIRED');
  // another account
  const other = await adult('other@example.org', 'other_one');
  assert.equal((await api().get(`/api/v1/profiles/${kid1.id}/sparks`).set(other.auth)).status, 404);
  assert.equal((await api().get(`/api/v1/profiles/${kid1.id}/sparks/history`).set(other.auth)).status, 404);

  // deleting a child deletes its ledger only (back to the parent area first: the switch moved this device session)
  const back = await api().post('/api/v1/profiles/parent-mode').set(kidAuth).send({ pin: '1234' });
  const del = await api().delete(`/api/v1/profiles/${kid2.id}`).set(bearer(back.body.accessToken)).send({ pin: '1234', confirm: true });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.equal((await h.query('SELECT COUNT(*) n FROM sparks_transactions WHERE profile_id = ?', [kid2.id]))[0].n, 0);
  assert.equal((await h.query('SELECT COUNT(*) n FROM profile_sparks WHERE profile_id = ?', [kid2.id]))[0].n, 0);
  assert.equal((await sparks.getBalance(kid1.id)).balance, 100);
});

test('spending never lowers lifetime earned; reverse and verifyPending keep the balance row equal to the ledger', async () => {
  const a = await adult();
  await sparks.spend({ profileId: a.profileId, amount: 40, transactionId: 'buy-1' });
  assert.deepEqual(await sparks.getBalance(a.profileId), { balance: 60, lifetimeEarned: 100, lifetimeSpent: 40, pending: 0 });
  // offline Sparks
  await sparks.addPending({ profileId: a.profileId, amount: 15, type: 'game', transactionId: 'offline-1' });
  assert.deepEqual(await sparks.getBalance(a.profileId), { balance: 60, lifetimeEarned: 100, lifetimeSpent: 40, pending: 15 });
  await assert.rejects(sparks.spend({ profileId: a.profileId, amount: 70, transactionId: 'buy-2' }), (e) => e.code === 'INSUFFICIENT_SPARKS', 'pending cannot be spent');
  assert.equal((await sparks.verifyPending('offline-1')).duplicate, false);
  assert.equal((await sparks.verifyPending('offline-1')).duplicate, true);
  assert.deepEqual(await sparks.getBalance(a.profileId), { balance: 75, lifetimeEarned: 115, lifetimeSpent: 40, pending: 0 });
  // refund a purchase, reverse a credit, drop a pending entry
  await sparks.reverse('buy-1', { reason: 'refund' });
  assert.deepEqual(await sparks.getBalance(a.profileId), { balance: 115, lifetimeEarned: 115, lifetimeSpent: 0, pending: 0 });
  assert.equal((await sparks.reverse('buy-1')).duplicate, true);
  await sparks.reverse('offline-1', { reason: 'score failed re-verification' });
  assert.deepEqual(await sparks.getBalance(a.profileId), { balance: 100, lifetimeEarned: 100, lifetimeSpent: 0, pending: 0 });
  await sparks.addPending({ profileId: a.profileId, amount: 9, type: 'quiz', transactionId: 'offline-2' });
  await sparks.reverse('offline-2');
  assert.equal((await sparks.getBalance(a.profileId)).pending, 0);
  await assert.rejects(sparks.verifyPending('offline-2'), (e) => e.code === 'TRANSACTION_REVERSED');
  await assert.rejects(sparks.verifyPending('nope'), (e) => e.code === 'TRANSACTION_NOT_FOUND');
  // a reversal cannot push the balance below zero
  await sparks.spend({ profileId: a.profileId, amount: 100, transactionId: 'buy-3' });
  await assert.rejects(sparks.reverse(`signup_bonus-account-${a.accountId}`), (e) => e.code === 'INSUFFICIENT_SPARKS');
  await assertConsistent(a.profileId);
});

test('history: newest first, paged, filterable by status', async () => {
  const a = await adult();
  for (let i = 1; i <= 5; i++) await sparks.credit({ profileId: a.profileId, amount: i, type: 'learn', transactionId: `learn-${i}` });
  await sparks.addPending({ profileId: a.profileId, amount: 3, type: 'game', transactionId: 'pend-1' });
  const r = await api().get(`/api/v1/profiles/${a.profileId}/sparks/history?page=1&pageSize=4`).set(a.auth);
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 7);
  assert.equal(r.body.items.length, 4);
  assert.deepEqual(r.body.items.map((t) => t.transactionId), ['pend-1', 'learn-5', 'learn-4', 'learn-3']);
  assert.match(r.body.items[0].createdAt, /Z$/);
  const p2 = await api().get(`/api/v1/profiles/${a.profileId}/sparks/history?page=2&pageSize=4`).set(a.auth);
  assert.deepEqual(p2.body.items.map((t) => t.transactionId), ['learn-2', 'learn-1', `signup_bonus-account-${a.accountId}`]);
  const pend = await api().get(`/api/v1/profiles/${a.profileId}/sparks/history?status=pending`).set(a.auth);
  assert.deepEqual(pend.body.items.map((t) => t.transactionId), ['pend-1']);
  assert.equal((await api().get(`/api/v1/profiles/${a.profileId}/sparks/history?pageSize=500`).set(a.auth)).status, 400);
});

test('referral: new user +25 at once; the referrer +50 stays PENDING until the first completed quiz', async () => {
  const friend = await adult('friend@example.org', 'friend_1');
  const code = (await api().get('/api/v1/me/referral').set(friend.auth)).body.code;
  const newbie = await adult('new@example.org', 'new_one');
  assert.equal((await api().post('/api/v1/me/referral/apply').set(newbie.auth).send({ code })).status, 200);
  const rf = (await h.query('SELECT id FROM referrals'))[0];

  assert.deepEqual(await sparks.getBalance(newbie.profileId), { balance: 125, lifetimeEarned: 125, lifetimeSpent: 0, pending: 0 });
  assert.deepEqual(await sparks.getBalance(friend.profileId), { balance: 100, lifetimeEarned: 100, lifetimeSpent: 0, pending: 50 });
  assert.deepEqual((await ledger(friend.profileId)).find((t) => t.type === 'referral'),
    { type: 'referral', amount: 50, status: 'pending', transaction_id: `referral-referrer-${rf.id}` });

  assert.equal(await R.onFirstQuizCompleted(newbie.profileId), true);
  assert.equal(await R.onFirstQuizCompleted(newbie.profileId), false);
  assert.deepEqual(await sparks.getBalance(friend.profileId), { balance: 150, lifetimeEarned: 150, lifetimeSpent: 0, pending: 0 });
  assert.equal((await h.query('SELECT status FROM referrals'))[0].status, 'credited');
  await assertConsistent(friend.profileId);
  await assertConsistent(newbie.profileId);
});

test('referral: a parent referrer with no child yet gets the pending row on the first child', async () => {
  const p = await h.parentLogin();
  const code = (await api().get('/api/v1/me/referral').set(p.auth)).body.code;
  const newbie = await adult('new@example.org', 'new_one');
  assert.equal((await api().post('/api/v1/me/referral/apply').set(newbie.auth).send({ code })).status, 200);
  assert.equal((await h.query("SELECT COUNT(*) n FROM sparks_transactions WHERE type = 'referral' AND status = 'pending'"))[0].n, 0);
  const kid = (await addChild(p, 'kid_one')).body.profile;
  assert.deepEqual(await sparks.getBalance(kid.id), { balance: 100, lifetimeEarned: 100, lifetimeSpent: 0, pending: 50 });
});

test('migration 020 moves reserved Sparks into the ledger; running it twice never doubles anything', async () => {
  // Milestone 1 state: rewards reserved, no ledger
  const a = await adult();
  const b = await adult('b@example.org', 'bina_b');
  const p = await h.parentLogin();
  const kid = (await addChild(p, 'kid_one')).body.profile;
  const kidless = await h.parentLogin('kidless@example.org');
  await h.query('TRUNCATE TABLE sparks_transactions');
  await h.query('TRUNCATE TABLE profile_sparks');
  await h.query("UPDATE signup_bonuses SET status = 'pending', credited_at = NULL");
  await h.query("INSERT INTO profile_sparks_rewards (profile_id, reward, sparks, tx_id) VALUES (?, 'student_verified', 10, ?), (?, 'student_interest_confirmed', 5, ?)",
    [a.profileId, `student_verified-${a.profileId}`, kid.id, `student_interest_confirmed-${kid.id}`]);
  await h.query(`INSERT INTO explore_import_items (tx_id, account_id, profile_id, kind, code, amount, client_at) VALUES
    ('aaaaaaaa-0000-4000-8000-000000000001', ?, ?, 'sparks', 'quiz_correct', 12, UTC_TIMESTAMP()),
    ('aaaaaaaa-0000-4000-8000-000000000002', ?, ?, 'purchase', 'crown_gold', 8, UTC_TIMESTAMP())`, [b.accountId, b.profileId, b.accountId, b.profileId]);
  const rfNew = await h.query("INSERT INTO referrals (referrer_account_id, referee_account_id, code, new_user_sparks, referrer_sparks) VALUES (?,?,'ABCDEF',25,50)", [a.accountId, b.accountId]);
  const rfQual = await h.query("INSERT INTO referrals (referrer_account_id, referee_account_id, code, status, new_user_sparks, new_user_status, referrer_sparks, qualified_at) VALUES (?,?,'ABCDEF','qualified',25,'credited',50,UTC_TIMESTAMP())", [p.account.id, a.accountId]);

  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '020_sparks_backfill_reserved.sql'), 'utf8');
  const conn = await mysql.createConnection({ ...config.db, multipleStatements: true, charset: 'utf8mb4' });
  try {
    await conn.query(sql);
    const snapshot = async () => ({
      tx: await h.query('SELECT profile_id, type, amount, status, transaction_id FROM sparks_transactions ORDER BY transaction_id'),
      bal: await h.query('SELECT profile_id, balance, lifetime_earned, lifetime_spent, pending FROM profile_sparks ORDER BY profile_id'),
    });
    const once = await snapshot();
    await conn.query(sql);
    assert.deepEqual(await snapshot(), once, 'second run: no change');
  } finally { await conn.end(); }

  const byId = (pid) => ledger(pid).then((rows) => rows.map((t) => [t.transaction_id, t.amount, t.status]).sort());
  assert.deepEqual(await byId(a.profileId), [
    [`referral-referrer-${rfNew.insertId}`, 50, 'pending'],
    [`signup_bonus-account-${a.accountId}`, 100, 'verified'],
    [`student_verified-${a.profileId}`, 10, 'verified'],
  ].sort());
  assert.deepEqual(await byId(b.profileId), [
    ['aaaaaaaa-0000-4000-8000-000000000001', 12, 'verified'],
    [`referral-new-${rfNew.insertId}`, 25, 'verified'],
    [`signup_bonus-account-${b.accountId}`, 100, 'verified'],
  ].sort());
  assert.deepEqual(await byId(kid.id), [
    [`referral-referrer-${rfQual.insertId}`, 50, 'verified'],
    [`signup_bonus-account-${p.account.id}`, 100, 'verified'],
    [`student_interest_confirmed-${kid.id}`, 5, 'verified'],
  ].sort());
  assert.deepEqual(await sparks.getBalance(a.profileId), { balance: 110, lifetimeEarned: 110, lifetimeSpent: 0, pending: 50 });
  assert.deepEqual(await sparks.getBalance(b.profileId), { balance: 137, lifetimeEarned: 137, lifetimeSpent: 0, pending: 0 });
  assert.deepEqual(await sparks.getBalance(kid.id), { balance: 155, lifetimeEarned: 155, lifetimeSpent: 0, pending: 0 });

  // statuses moved on; the kidless parent keeps its bonus pending; purchases stay for Dress Up
  const bonus = await h.query('SELECT account_id, status FROM signup_bonuses ORDER BY account_id');
  assert.deepEqual(bonus.map((x) => [x.account_id, x.status]),
    [[a.accountId, 'credited'], [b.accountId, 'credited'], [p.account.id, 'credited'], [kidless.account.id, 'pending']]);
  assert.deepEqual((await h.query('SELECT status FROM profile_sparks_rewards')).map((x) => x.status), ['credited', 'credited']);
  assert.deepEqual((await h.query('SELECT kind, status FROM explore_import_items ORDER BY kind')).map((x) => [x.kind, x.status]), [['sparks', 'credited'], ['purchase', 'pending_import']]);
  assert.deepEqual((await h.query('SELECT status, new_user_status FROM referrals ORDER BY id')).map((x) => [x.status, x.new_user_status]),
    [['waiting_for_first_quiz', 'credited'], ['credited', 'credited']]);

  // the code uses the same transaction ids: nothing is paid again
  const token = (await h.adminLogin(await h.makeAdmin('boss@example.org'))).token;
  await h.query("UPDATE profiles SET student_status = 'pending_verification' WHERE id = ?", [a.profileId]);
  const v = await api().post(`/api/v1/admin/profiles/${a.profileId}/student-status`).set(bearer(token)).send({ action: 'verify' });
  assert.equal(v.body.sparksAwarded, 0);
  await addChild(p, 'kid_two');
  assert.equal((await sparks.getBalance(kid.id)).balance, 155);
  for (const id of [a.profileId, b.profileId, kid.id]) await assertConsistent(id);
});

test('student verify / confirm interest credit the ledger once, in the same transaction', async () => {
  const token = (await h.adminLogin(await h.makeAdmin('boss@example.org'))).token;
  const a = await adult();
  await api().put(`/api/v1/profiles/${a.profileId}/student-status`).set(a.auth).send({ enrolled: true });
  await api().post(`/api/v1/admin/profiles/${a.profileId}/student-status`).set(bearer(token)).send({ action: 'verify' });
  await api().post(`/api/v1/admin/profiles/${a.profileId}/student-status`).set(bearer(token)).send({ action: 'reset' });
  await api().put(`/api/v1/profiles/${a.profileId}/student-status`).set(a.auth).send({ enrolled: false, interested: true });
  await api().post(`/api/v1/admin/profiles/${a.profileId}/student-status`).set(bearer(token)).send({ action: 'confirm_interest' });
  const rows = (await ledger(a.profileId)).filter((t) => t.type.startsWith('student'));
  assert.deepEqual(rows.map((t) => [t.type, t.amount, t.status]), [['student_verified', 10, 'verified'], ['student_interest', 5, 'verified']]);
  const tx = (await h.query("SELECT created_by FROM sparks_transactions WHERE type = 'student_verified'"))[0];
  assert.ok(tx.created_by, 'the verifying admin is recorded');
  assert.equal((await sparks.getBalance(a.profileId)).balance, 115);
  assert.equal((await h.query('SELECT COUNT(*) n FROM profile_sparks_rewards'))[0].n, 0, 'no new reserved rows');
});

test('admin: balance + history per profile; adjust with a required reason, audited, never below zero', async () => {
  const boss = await h.makeAdmin('boss@example.org');
  const A = bearer((await h.adminLogin(boss)).token);
  const a = await adult();

  const add = await api().post(`/api/v1/admin/profiles/${a.profileId}/sparks/adjust`).set(A).send({ amount: 50, reason: 'Satsang sabha prize', transactionId: 'adj-1' });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  assert.equal(add.body.balance, 150);
  assert.equal(add.body.transaction.type, 'admin_adjust');
  assert.equal(add.body.transaction.createdBy, boss.id);
  assert.equal(add.body.transaction.note, 'Satsang sabha prize');
  const dup = await api().post(`/api/v1/admin/profiles/${a.profileId}/sparks/adjust`).set(A).send({ amount: 50, reason: 'Satsang sabha prize', transactionId: 'adj-1' });
  assert.equal(dup.status, 200); assert.equal(dup.body.duplicate, true); assert.equal(dup.body.balance, 150);

  const sub = await api().post(`/api/v1/admin/profiles/${a.profileId}/sparks/adjust`).set(A).send({ amount: -30, reason: 'Correction' });
  assert.equal(sub.status, 201);
  assert.equal(sub.body.balance, 120);
  assert.equal(sub.body.lifetimeEarned, 120, 'a deduction is a correction of earned Sparks');
  const tooMuch = await api().post(`/api/v1/admin/profiles/${a.profileId}/sparks/adjust`).set(A).send({ amount: -1000, reason: 'Correction' });
  assert.equal(tooMuch.status, 409); assert.equal(tooMuch.body.error.code, 'INSUFFICIENT_SPARKS');
  for (const body of [{ amount: 5 }, { amount: 5, reason: '  ' }, { amount: 0, reason: 'zero' }, { amount: 1.5, reason: 'half' }]) {
    assert.equal((await api().post(`/api/v1/admin/profiles/${a.profileId}/sparks/adjust`).set(A).send(body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await api().post('/api/v1/admin/profiles/999999/sparks/adjust').set(A).send({ amount: 5, reason: 'nobody' })).status, 404);

  const logs = await auditRows('sparks.adjusted');
  assert.equal(logs.length, 2, 'the duplicate and the refused ones are not audited');
  assert.equal(logs[0].entity_type, 'profile'); assert.equal(logs[0].entity_id, String(a.profileId));
  assert.deepEqual(details(logs[0]), { amount: 50, reason: 'Satsang sabha prize', transactionId: 'adj-1', balanceAfter: 150 });

  const bal = await api().get(`/api/v1/admin/profiles/${a.profileId}/sparks`).set(A);
  assert.deepEqual(bal.body, { profileId: a.profileId, accountId: a.accountId, username: 'ravi_k', isChild: false, balance: 120, lifetimeEarned: 120, lifetimeSpent: 0, pending: 0 });
  const hist = await api().get(`/api/v1/admin/profiles/${a.profileId}/sparks/history?type=admin_adjust`).set(A);
  assert.equal(hist.status, 200);
  assert.deepEqual(hist.body.items.map((t) => [t.amount, t.note, t.createdBy]), [[-30, 'Correction', boss.id], [50, 'Satsang sabha prize', boss.id]]);
  assert.equal(hist.body.total, 2);

  // the app sees the adjustment but not the admin's note or id
  const appHist = await api().get(`/api/v1/profiles/${a.profileId}/sparks/history`).set(a.auth);
  assert.equal(appHist.body.items[0].type, 'admin_adjust');
  assert.equal(appHist.body.items[0].note, undefined);
  assert.equal(appHist.body.items[0].createdBy, undefined);

  // Full Admin only
  const editor = bearer((await h.adminLogin(await h.makeAdmin('editor@example.org', 'content_editor'))).token);
  assert.equal((await api().get(`/api/v1/admin/profiles/${a.profileId}/sparks`).set(editor)).status, 403);
  assert.equal((await api().get(`/api/v1/admin/profiles/${a.profileId}/sparks/history`).set(editor)).status, 403);
  assert.equal((await api().post(`/api/v1/admin/profiles/${a.profileId}/sparks/adjust`).set(editor).send({ amount: 5, reason: 'try' })).status, 403);
  await assertConsistent(a.profileId);
});

test('reward config: per activity and age group, seeded defaults, Full Admin edits are audited', async () => {
  const A = bearer((await h.adminLogin(await h.makeAdmin('boss@example.org'))).token);
  const g = await api().get('/api/v1/admin/sparks/config').set(A);
  assert.equal(g.status, 200);
  assert.deepEqual(g.body.activities, ['quiz', 'game', 'puzzle', 'learn']);
  assert.equal(g.body.ageGroups.length, 9);
  assert.equal(g.body.rewards.length, 36);
  assert.ok(g.body.rewards.every((r) => r.isDefault));
  assert.match(g.body.note, /Loyadham/);
  const get = (activity, ageGroup) => g.body.rewards.find((r) => r.activity === activity && r.ageGroup === ageGroup).sparks;
  for (const young of ['Shishu', 'Bals/Balikas B', 'Kishors/Kishoris B']) assert.ok(get('game', young) > get('puzzle', young), young);
  for (const older of ['Yuvak/Yuvatis A', 'Yuvaks/Yuvatis B', 'Vadil']) assert.ok(get('puzzle', older) > get('game', older), older);
  const quizzes = g.body.rewards.filter((r) => r.activity === 'quiz').map((r) => r.sparks);
  assert.ok(quizzes.every((q) => q >= Math.max(...g.body.rewards.filter((r) => r.activity !== 'quiz').map((r) => r.sparks))), 'quizzes high for all');

  const put = await api().put('/api/v1/admin/sparks/config').set(A).send({ rewards: [
    { activity: 'game', ageGroup: 'Vadil', sparks: 7 }, { activity: 'quiz', ageGroup: 'Vadil', sparks: 20 } ] });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.deepEqual(put.body.changed, [{ activity: 'game', ageGroup: 'Vadil', from: 5, to: 7 }], 'unchanged rows are not reported');
  const row = put.body.rewards.find((r) => r.activity === 'game' && r.ageGroup === 'Vadil');
  assert.equal(row.sparks, 7); assert.equal(row.defaultSparks, 5); assert.equal(row.isDefault, false);
  assert.equal(await sparks.rewardFor('game', 'Vadil'), 7);
  assert.equal(await sparks.rewardFor('quiz', 'Shishu'), 20);
  const logs = await auditRows('sparks.config_changed');
  assert.equal(logs.length, 1);
  assert.deepEqual(details(logs[0]), { changes: [{ activity: 'game', ageGroup: 'Vadil', from: 5, to: 7 }] });

  for (const rewards of [[], [{ activity: 'cricket', ageGroup: 'Vadil', sparks: 1 }], [{ activity: 'quiz', ageGroup: 'Adults', sparks: 1 }],
    [{ activity: 'quiz', ageGroup: 'Vadil', sparks: -1 }], [{ activity: 'quiz', ageGroup: 'Vadil', sparks: 1 }, { activity: 'quiz', ageGroup: 'Vadil', sparks: 2 }]]) {
    assert.equal((await api().put('/api/v1/admin/sparks/config').set(A).send({ rewards })).status, 400, JSON.stringify(rewards));
  }
  const editor = bearer((await h.adminLogin(await h.makeAdmin('editor@example.org', 'content_editor'))).token);
  assert.equal((await api().get('/api/v1/admin/sparks/config').set(editor)).status, 403);
  assert.equal((await api().put('/api/v1/admin/sparks/config').set(editor).send({ rewards: [{ activity: 'quiz', ageGroup: 'Vadil', sparks: 1 }] })).status, 403);
});

test('/api-docs.json documents the Sparks endpoints and sparksBalance', async () => {
  const d = (await api().get('/api-docs.json')).body;
  for (const p of ['/profiles/{id}/sparks', '/profiles/{id}/sparks/history', '/admin/profiles/{id}/sparks', '/admin/profiles/{id}/sparks/history',
    '/admin/profiles/{id}/sparks/adjust', '/admin/sparks/config']) assert.ok(d.paths[p], p);
  assert.ok(d.paths['/admin/sparks/config'].put);
  assert.ok(d.components.schemas.Profile.properties.sparksBalance);
  assert.deepEqual(Object.keys(d.components.schemas.SparksBalance.properties), ['balance', 'lifetimeEarned', 'lifetimeSpent', 'pending']);
});
