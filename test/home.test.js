// Milestone 2, chunk 2.3A: Home tab (contract 6.7 + 8.3) — Daily Spin, Streak Bonus, News, Feedback, Donate URL.
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { api, bearer } = h;
const dailySpin = require('../src/services/dailySpin');
const streak = require('../src/services/streak');
const sparks = require('../src/services/sparks');

beforeEach(h.resetDb);
after(() => h.pool.end());

const HOUR = 3600 * 1000;
async function adult(email = 'ravi@example.org', username = 'ravi_k') {
  const b = await h.adultLogin(email, username);
  return { auth: bearer(b.accessToken), profileId: b.profiles[0].id, accountId: b.account.id };
}
const auditRows = (action) => h.query('SELECT * FROM audit_log WHERE action = ? ORDER BY id', [action]);
const details = (row) => (typeof row.details === 'string' ? JSON.parse(row.details) : row.details);
const balance = async (id) => (await sparks.getBalance(id)).balance;
async function admin(role = 'full_admin', email = 'boss@example.org') {
  return bearer((await h.adminLogin(await h.makeAdmin(email, role))).token);
}

// ---------------------------------------------------------------- Daily Spin

test('daily spin: server picks a segment, credits the ledger, cannot spin twice; same transactionId → same result', async () => {
  const a = await adult();
  const s0 = await api().get(`/api/v1/profiles/${a.profileId}/spin`).set(a.auth);
  assert.equal(s0.status, 200);
  assert.equal(s0.body.available, true);
  assert.equal(s0.body.segments.length, dailySpin.DEFAULT_SEGMENTS.length);
  assert.equal(s0.body.segments[0].weight, undefined, 'the app gets no weights');

  const r = await api().post(`/api/v1/profiles/${a.profileId}/spin`).set(a.auth).send({ transactionId: 'spin-0001' });
  assert.equal(r.status, 201);
  const seg = s0.body.segments[r.body.segmentIndex];
  assert.equal(r.body.reward, seg.sparks);
  assert.equal(r.body.duplicate, false);
  assert.equal(new Date(r.body.nextAvailableAt) - new Date(r.body.spunAt), 24 * HOUR);
  assert.equal(r.body.balance.balance, 100 + seg.sparks);
  const led = await h.query("SELECT amount, status FROM sparks_transactions WHERE transaction_id = 'spin-0001' AND type = 'daily_spin'");
  assert.deepEqual(led.map((x) => ({ ...x })), [{ amount: seg.sparks, status: 'verified' }]);

  const again = await api().post(`/api/v1/profiles/${a.profileId}/spin`).set(a.auth).send({ transactionId: 'spin-0001' });
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  assert.equal(again.body.segmentIndex, r.body.segmentIndex);
  assert.equal(again.body.reward, r.body.reward);

  const second = await api().post(`/api/v1/profiles/${a.profileId}/spin`).set(a.auth).send({ transactionId: 'spin-0002' });
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'SPIN_NOT_AVAILABLE');
  assert.equal(second.body.error.details.nextAvailableAt, r.body.nextAvailableAt);
  assert.equal(await balance(a.profileId), 100 + seg.sparks, 'paid once');
  const s1 = await api().get(`/api/v1/profiles/${a.profileId}/spin`).set(a.auth);
  assert.equal(s1.body.available, false);
  assert.equal(s1.body.nextAvailableAt, r.body.nextAvailableAt);

  // a transactionId already used elsewhere in the ledger (or by another profile) → 409, nothing written
  const b = await adult('b@example.org', 'bina_b');
  const other = await api().post(`/api/v1/profiles/${b.profileId}/spin`).set(b.auth).send({ transactionId: 'spin-0001' });
  assert.equal(other.status, 409);
  assert.equal(other.body.error.code, 'TRANSACTION_ID_CONFLICT');
  const reused = await api().post(`/api/v1/profiles/${b.profileId}/spin`).set(b.auth).send({ transactionId: `signup_bonus-account-${b.accountId}` });
  assert.equal(reused.body.error.code, 'TRANSACTION_ID_CONFLICT');
  assert.equal((await h.query('SELECT COUNT(*) AS n FROM daily_spins WHERE profile_id = ?', [b.profileId]))[0].n, 0);
  assert.equal(await balance(b.profileId), 100);
});

test('daily spin is rolling 24 h: not before, available exactly 24 h after the last spin, and an unclaimed spin stays available', async () => {
  const a = await adult();
  const t0 = new Date('2026-11-20T15:30:00Z');
  const first = await dailySpin.spin(a.profileId, 'roll-1', t0);
  assert.equal(first.nextAvailableAt, '2026-11-21T15:30:00.000Z');
  assert.equal((await dailySpin.getStatus(a.profileId, new Date(t0.getTime() + 24 * HOUR - 1000))).available, false);
  // a new calendar day (even in New York) does not matter: only the 24 hours
  assert.equal((await dailySpin.getStatus(a.profileId, new Date('2026-11-21T06:00:00Z'))).available, false);
  await assert.rejects(dailySpin.spin(a.profileId, 'roll-2', new Date(t0.getTime() + 24 * HOUR - 1000)), (e) => e.code === 'SPIN_NOT_AVAILABLE');
  assert.equal((await dailySpin.getStatus(a.profileId, new Date(t0.getTime() + 24 * HOUR))).available, true, 'exactly 24 h');

  // not spun for 3 days: still available (never expires); the next timer starts from the actual spin
  const late = new Date(t0.getTime() + 72 * HOUR + 7 * 60 * 1000);
  assert.equal((await dailySpin.getStatus(a.profileId, late)).available, true);
  const second = await dailySpin.spin(a.profileId, 'roll-3', late);
  assert.equal(second.nextAvailableAt, new Date(late.getTime() + 24 * HOUR).toISOString());
  assert.equal((await dailySpin.getStatus(a.profileId, new Date(late.getTime() + 23 * HOUR))).available, false);
  assert.equal((await h.query("SELECT COUNT(*) AS n FROM sparks_transactions WHERE type = 'daily_spin'"))[0].n, 2);
});

test('daily spin: only the playing profile spins; weighted pick; admin wheel (Full Admin, audited)', async () => {
  const parent = await h.parentLogin();
  const c = await api().post('/api/v1/profiles').set(parent.auth).send({ username: 'kid_one', avatarId: 2, dob: h.dobYearsAgo(9), parentalConsent: true, pin: '1234' });
  const childId = c.body.profile.id;
  assert.equal((await api().get(`/api/v1/profiles/${childId}/spin`).set(parent.auth)).status, 200, 'parent area can look');
  const no = await api().post(`/api/v1/profiles/${childId}/spin`).set(parent.auth).send({ transactionId: 'p-spin' });
  assert.equal(no.status, 403);
  assert.equal(no.body.error.code, 'PROFILE_NOT_ACTIVE');
  const sw = await api().post(`/api/v1/profiles/${childId}/switch`).set(parent.auth).send({ pin: '1234' });
  const child = bearer(sw.body.accessToken);
  assert.equal((await api().post(`/api/v1/profiles/${childId}/spin`).set(child).send({ transactionId: 'c-spin' })).status, 201);

  // weights are respected (weight 1 vs 999)
  let rare = 0;
  for (let i = 0; i < 3000; i++) if (dailySpin.pick([{ index: 0, weight: 1 }, { index: 1, weight: 999 }]).index === 0) rare++;
  assert.ok(rare < 40, `rare segment picked ${rare} times`);

  const editor = await admin('content_editor', 'ed@example.org');
  assert.equal((await api().get('/api/v1/admin/home/spin-segments').set(editor)).status, 403);
  const full = await admin();
  const g = await api().get('/api/v1/admin/home/spin-segments').set(full);
  assert.equal(g.body.isDefault, true);
  assert.match(g.body.note, /confirmed by Loyadham/);
  assert.equal(g.body.segments[0].weight, 25);
  assert.equal(Math.round(g.body.segments.reduce((n, s) => n + s.chancePercent, 0)), 100);
  assert.equal((await api().put('/api/v1/admin/home/spin-segments').set(full).send({ segments: [{ sparks: 5, weight: 1 }] })).status, 400, 'at least 2');
  assert.equal((await api().put('/api/v1/admin/home/spin-segments').set(full).send({ segments: [{ sparks: 0, weight: 1 }, { sparks: 5, weight: 1 }] })).status, 400, 'no 0 Sparks segment');
  const put = await api().put('/api/v1/admin/home/spin-segments').set(full).send({ segments: [{ label: 'Small', sparks: 7, weight: 1 }, { label: 'Big', sparks: 70, weight: 1000 }] });
  assert.equal(put.status, 200);
  assert.equal(put.body.isDefault, false);
  const au = await auditRows('spin.segments_changed');
  assert.equal(au.length, 1);
  assert.equal(details(au[0]).to[1].sparks, 70);
  const appView = await api().get(`/api/v1/profiles/${childId}/spin`).set(child);
  assert.deepEqual(appView.body.segments, [{ index: 0, label: 'Small', sparks: 7 }, { index: 1, label: 'Big', sparks: 70 }]);
  // saving the same wheel again is not a change
  await api().put('/api/v1/admin/home/spin-segments').set(full).send({ segments: [{ label: 'Small', sparks: 7, weight: 1 }, { label: 'Big', sparks: 70, weight: 1000 }] });
  assert.equal((await auditRows('spin.segments_changed')).length, 1);
});

// ---------------------------------------------------------------- Streak Bonus

test('streak: consecutive New York days count, the NY midnight is the boundary, a day counts once', async () => {
  const a = await adult();
  const at = (s) => new Date(s);
  let r = await streak.checkIn(a.profileId, at('2026-11-20T15:00:00Z'));
  assert.deepEqual([r.counted, r.currentStreak, r.unclaimed, r.lastActiveDay], [true, 1, 5, '2026-11-20']);
  r = await streak.checkIn(a.profileId, at('2026-11-20T23:00:00Z'));
  assert.equal(r.counted, false, 'same day');
  // 04:59 UTC on 21 Nov is still 20 Nov 23:59 in New York (EST, UTC-5)
  r = await streak.checkIn(a.profileId, at('2026-11-21T04:59:59Z'));
  assert.deepEqual([r.counted, r.currentStreak], [false, 1]);
  r = await streak.checkIn(a.profileId, at('2026-11-21T05:00:00Z'));
  assert.deepEqual([r.counted, r.currentStreak, r.unclaimed, r.lastActiveDay], [true, 2, 15, '2026-11-21']);
  const g = await streak.getStreak(a.profileId, at('2026-11-22T12:00:00Z'));
  assert.deepEqual([g.currentStreak, g.unclaimed, g.checkedInToday, g.nextDayBonus], [2, 15, false, 15], 'yesterday counts: still alive');
});

test('streak across the DST changes (America/New_York): spring forward and fall back', async () => {
  const a = await adult();
  const b = await adult('b@example.org', 'bina_b');
  const at = (s) => new Date(s);
  // spring forward 8 Mar 2026: midnight is 05:00 UTC before, 04:00 UTC after
  await streak.checkIn(a.profileId, at('2026-03-07T15:00:00Z'));                         // 7 Mar
  assert.equal((await streak.checkIn(a.profileId, at('2026-03-08T04:59:00Z'))).counted, false);   // 7 Mar 23:59 EST
  assert.equal((await streak.checkIn(a.profileId, at('2026-03-08T05:00:00Z'))).currentStreak, 2); // 8 Mar 00:00 EST
  assert.equal((await streak.checkIn(a.profileId, at('2026-03-09T03:59:00Z'))).counted, false);   // 8 Mar 23:59 EDT
  const r = await streak.checkIn(a.profileId, at('2026-03-09T04:00:00Z'));                        // 9 Mar 00:00 EDT
  assert.deepEqual([r.counted, r.currentStreak, r.lastActiveDay], [true, 3, '2026-03-09']);
  // fall back 1 Nov 2026: midnight is 04:00 UTC before, 05:00 UTC after (1 Nov has 25 hours)
  await streak.checkIn(b.profileId, at('2026-10-31T15:00:00Z'));                          // 31 Oct
  assert.equal((await streak.checkIn(b.profileId, at('2026-11-01T04:00:00Z'))).currentStreak, 2); // 1 Nov 00:00 EDT
  assert.equal((await streak.checkIn(b.profileId, at('2026-11-02T04:59:00Z'))).counted, false);   // 1 Nov 23:59 EST
  const f = await streak.checkIn(b.profileId, at('2026-11-02T05:00:00Z'));                        // 2 Nov 00:00 EST
  assert.deepEqual([f.currentStreak, f.lastActiveDay], [3, '2026-11-02']);
});

test('streak claim credits the unclaimed bonus and resets ONLY the unclaimed amount; idempotent; nothing to claim → 409', async () => {
  const a = await adult();
  for (const d of ['2026-11-20', '2026-11-21', '2026-11-22']) await streak.checkIn(a.profileId, new Date(`${d}T15:00:00Z`));
  const day3 = new Date('2026-11-22T18:00:00Z');
  const c = await streak.claim(a.profileId, 'streak-claim-1', day3);
  assert.deepEqual([c.duplicate, c.claimed, c.currentStreak, c.unclaimed], [false, 30, 3, 0]);   // 5 + 10 + 15
  assert.equal(c.balance.balance, 130);
  const dup = await streak.claim(a.profileId, 'streak-claim-1', day3);
  assert.deepEqual([dup.duplicate, dup.claimed], [true, 30]);
  await assert.rejects(streak.claim(a.profileId, 'streak-claim-2', day3), (e) => e.code === 'NOTHING_TO_CLAIM');
  assert.equal(await balance(a.profileId), 130, 'paid once');
  // the streak keeps going: day 4 adds 20
  const d4 = await streak.checkIn(a.profileId, new Date('2026-11-23T15:00:00Z'));
  assert.deepEqual([d4.currentStreak, d4.unclaimed], [4, 20]);
  // a claim on a new day counts that day first
  const d5 = await streak.claim(a.profileId, 'streak-claim-3', new Date('2026-11-24T15:00:00Z'));
  assert.deepEqual([d5.claimed, d5.currentStreak, d5.unclaimed], [45, 5, 0]);   // 20 + 25
  const led = await h.query("SELECT amount FROM sparks_transactions WHERE profile_id = ? AND type = 'streak' ORDER BY id", [a.profileId]);
  assert.deepEqual(led.map((x) => x.amount), [30, 45]);
  const b = await adult('b@example.org', 'bina_b');
  await assert.rejects(streak.claim(b.profileId, 'streak-claim-1'), (e) => e.code === 'TRANSACTION_ID_CONFLICT');
});

test('a broken streak loses the unclaimed bonus and starts again at day 1', async () => {
  const a = await adult();
  await streak.checkIn(a.profileId, new Date('2026-11-20T15:00:00Z'));
  await streak.checkIn(a.profileId, new Date('2026-11-21T15:00:00Z'));   // streak 2, unclaimed 15
  // 22 Nov missed
  const g = await streak.getStreak(a.profileId, new Date('2026-11-23T15:00:00Z'));
  assert.deepEqual([g.currentStreak, g.unclaimed, g.lostUnclaimed], [0, 0, 15]);
  const r = await streak.checkIn(a.profileId, new Date('2026-11-23T15:00:00Z'));
  assert.deepEqual([r.currentStreak, r.unclaimed, r.lost, r.bestStreak], [1, 5, 15, 2]);
  assert.equal(await balance(a.profileId), 100, 'the lost bonus was never credited');
  const c = await streak.claim(a.profileId, 'after-break', new Date('2026-11-23T16:00:00Z'));
  assert.equal(c.claimed, 5);
});

test('streak over HTTP: heartbeat and check-in count today, claim, admin amounts (Full Admin, audited)', async () => {
  const a = await adult();
  const s0 = await api().get(`/api/v1/profiles/${a.profileId}/streak`).set(a.auth);
  assert.equal(s0.status, 200);
  assert.deepEqual([s0.body.currentStreak, s0.body.unclaimed, s0.body.lastActiveDay, s0.body.gameTimeZone], [0, 0, null, 'America/New_York']);
  // the app's heartbeat counts today (server time); queued beats from earlier days never add streak days
  const beat = await api().post('/api/v1/me/activity/heartbeat').set(a.auth).send({ beats: [{ at: new Date(Date.now() - 20 * HOUR).toISOString(), seconds: 60 }] });
  assert.equal(beat.status, 200);
  assert.equal((await api().post('/api/v1/profiles/activity').set(a.auth).send({ seconds: 60 })).status, 200);
  const s1 = await api().get(`/api/v1/profiles/${a.profileId}/streak`).set(a.auth);
  assert.deepEqual([s1.body.currentStreak, s1.body.unclaimed, s1.body.checkedInToday], [1, 5, true]);
  const ci = await api().post(`/api/v1/profiles/${a.profileId}/streak/check-in`).set(a.auth);
  assert.deepEqual([ci.status, ci.body.counted, ci.body.currentStreak], [200, false, 1]);
  const cl = await api().post(`/api/v1/profiles/${a.profileId}/streak/claim`).set(a.auth).send({ transactionId: 'claim-http-1' });
  assert.deepEqual([cl.status, cl.body.claimed, cl.body.currentStreak, cl.body.unclaimed], [201, 5, 1, 0]);
  assert.equal((await api().post(`/api/v1/profiles/${a.profileId}/streak/claim`).set(a.auth).send({ transactionId: 'claim-http-1' })).status, 200);
  const none = await api().post(`/api/v1/profiles/${a.profileId}/streak/claim`).set(a.auth).send({ transactionId: 'claim-http-2' });
  assert.equal(none.body.error.code, 'NOTHING_TO_CLAIM');
  assert.equal((await api().post(`/api/v1/profiles/${a.profileId}/streak/claim`).set(a.auth).send({})).status, 400, 'transactionId required');

  const full = await admin();
  const g = await api().get('/api/v1/admin/home/streak-bonus').set(full);
  assert.deepEqual([g.body.isDefault, g.body.amounts], [true, streak.DEFAULT_AMOUNTS]);
  assert.equal((await api().put('/api/v1/admin/home/streak-bonus').set(full).send({ amounts: [] })).status, 400);
  const put = await api().put('/api/v1/admin/home/streak-bonus').set(full).send({ amounts: [2, 4] });
  assert.deepEqual([put.status, put.body.amounts, put.body.isDefault], [200, [2, 4], false]);
  assert.deepEqual(details((await auditRows('streak.amounts_changed'))[0]), { from: streak.DEFAULT_AMOUNTS, to: [2, 4] });
  const b = await adult('b@example.org', 'bina_b');
  for (const [d, want] of [['2026-11-20', 2], ['2026-11-21', 6], ['2026-11-22', 10]]) {
    assert.equal((await streak.checkIn(b.profileId, new Date(`${d}T15:00:00Z`))).unclaimed, want, 'days after the last use the last amount');
  }
  assert.equal((await api().put('/api/v1/admin/home/streak-bonus').set(await admin('content_editor', 'ed@example.org')).send({ amounts: [1] })).status, 403);
});

test('deleting a child profile removes its spins and streak (ON DELETE CASCADE)', async () => {
  const parent = await h.parentLogin();
  const c = await api().post('/api/v1/profiles').set(parent.auth).send({ username: 'kid_one', avatarId: 2, dob: h.dobYearsAgo(9), parentalConsent: true, pin: '1234' });
  const id = c.body.profile.id;
  await dailySpin.spin(id, 'kid-spin');
  await streak.checkIn(id);
  const d = await api().delete(`/api/v1/profiles/${id}`).set(parent.auth).send({ pin: '1234', confirm: true });
  assert.equal(d.status, 200);
  for (const t of ['daily_spins', 'profile_streaks']) assert.equal((await h.query(`SELECT COUNT(*) AS n FROM ${t} WHERE profile_id = ?`, [id]))[0].n, 0, t);
});

// ---------------------------------------------------------------- News

test('news: admin CRUD (Content Editor too, audited); app sees active + published only, pinned first, then newest', async () => {
  const ed = await admin('content_editor', 'ed@example.org');
  const ago = (days) => new Date(Date.now() - days * 24 * HOUR).toISOString();
  const mk = (o) => api().post('/api/v1/admin/news').set(ed).send({ titleEn: 'T', bodyEn: 'B', ...o });
  const old = await mk({ titleEn: 'Old', titleGu: 'જૂનું', bodyGu: 'સમાચાર', publishAt: ago(20) });
  assert.equal(old.status, 201);
  assert.deepEqual(old.body.news.title, { en: 'Old', gu: 'જૂનું' });
  const newer = await mk({ titleEn: 'Newer', publishAt: ago(5), imageUrl: 'https://cdn.example.org/n.png' });
  const pinned = await mk({ titleEn: 'Pinned', publishAt: ago(50), pinned: true });
  await mk({ titleEn: 'Future', publishAt: new Date(Date.now() + 48 * HOUR).toISOString() });
  await mk({ titleEn: 'Hidden', publishAt: ago(10), active: false });
  const now = await mk({ titleEn: 'Now' });   // publishAt defaults to now
  assert.equal((await mk({ imageUrl: 'http://insecure.example.org/x.png' })).status, 400, 'https images only');
  assert.equal((await mk({ titleEn: '' })).status, 400);

  const feed = await api().get('/api/v1/news');   // public
  assert.equal(feed.status, 200);
  assert.deepEqual(feed.body.items.map((n) => n.title.en), ['Pinned', 'Now', 'Newer', 'Old']);
  assert.equal(feed.body.total, 4);
  assert.equal(feed.body.items[2].imageUrl, 'https://cdn.example.org/n.png');
  assert.equal(feed.body.items[0].active, undefined, 'no admin fields in the app');
  const p2 = await api().get('/api/v1/news?page=2&pageSize=3');
  assert.deepEqual(p2.body.items.map((n) => n.title.en), ['Old']);

  const patch = await api().patch(`/api/v1/admin/news/${pinned.body.news.id}`).set(ed).send({ pinned: false, bodyEn: 'Changed' });
  assert.equal(patch.status, 200);
  assert.deepEqual((await api().get('/api/v1/news')).body.items.map((n) => n.title.en), ['Now', 'Newer', 'Old', 'Pinned']);
  const up = details((await auditRows('news.updated'))[0]);
  assert.deepEqual(up, { pinned: { from: true, to: false }, bodyEn: { changed: true } });

  const list = await api().get('/api/v1/admin/news?status=scheduled').set(ed);
  assert.deepEqual(list.body.items.map((n) => n.title.en), ['Future']);
  assert.equal((await api().get('/api/v1/admin/news?status=inactive').set(ed)).body.items[0].title.en, 'Hidden');
  assert.equal((await api().get('/api/v1/admin/news?q=Newer').set(ed)).body.total, 1);

  assert.equal((await api().delete(`/api/v1/admin/news/${now.body.news.id}`).set(ed)).status, 200);
  assert.equal((await api().get(`/api/v1/admin/news/${now.body.news.id}`).set(ed)).status, 404);
  assert.equal((await auditRows('news.created')).length, 6);
  assert.equal((await auditRows('news.deleted')).length, 1);
  assert.equal(newer.status, 201);
});

// ---------------------------------------------------------------- Feedback

test('feedback: stored for the profile, validated, rate limited per account; admin list / search / resolve (audited)', async () => {
  const a = await adult();
  const send = (o = {}, auth = a.auth) => api().post('/api/v1/feedback').set(auth)
    .send({ profileId: a.profileId, category: 'bug', message: 'The quiz froze', appVersion: '1.0.3', device: 'Pixel 7, Android 15', ...o });
  const r = await send();
  assert.equal(r.status, 201);
  assert.equal(r.body.received, true);
  assert.equal((await send({ message: 'x'.repeat(1001) })).status, 400);
  assert.equal((await send({ category: 'praise' })).status, 400);
  assert.equal((await send({ message: '   ' })).status, 400);
  assert.equal((await api().post('/api/v1/feedback').send({ profileId: a.profileId, category: 'bug', message: 'x' })).status, 401);
  const b = await adult('b@example.org', 'bina_b');
  assert.equal((await send({ profileId: b.profileId })).status, 404, "another account's profile");

  for (let i = 0; i < 4; i++) assert.equal((await send({ category: 'idea', message: `Idea ${i}` })).status, 201);
  const limited = await send();
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, 'FEEDBACK_RATE_LIMITED');
  assert.equal((await send({ profileId: b.profileId, message: 'Love the new jigsaw' }, b.auth)).status, 201, 'other accounts are not affected');
  // older than an hour no longer counts for the hourly limit
  await h.query('UPDATE feedback SET created_at = created_at - INTERVAL 2 HOUR WHERE account_id = ?', [a.accountId]);
  assert.equal((await send()).status, 201);

  const ed = await admin('content_editor', 'ed@example.org');
  assert.equal((await api().get('/api/v1/admin/feedback').set(ed)).status, 403);
  const full = await admin();
  const all = await api().get('/api/v1/admin/feedback').set(full);
  assert.equal(all.status, 200);
  assert.equal(all.body.total, 7);
  assert.equal(all.body.openCount, 7);
  assert.equal(all.body.items[0].username, 'ravi_k');
  assert.equal(all.body.items[0].email, undefined);
  assert.equal((await api().get('/api/v1/admin/feedback?q=jigsaw').set(full)).body.items[0].username, 'bina_b');
  assert.equal((await api().get('/api/v1/admin/feedback?q=bina').set(full)).body.total, 1);
  assert.equal((await api().get('/api/v1/admin/feedback?category=idea').set(full)).body.total, 4);
  const id = r.body.id;
  assert.equal((await api().get(`/api/v1/admin/feedback?q=%23${id}`).set(full)).body.items[0].message, 'The quiz froze');
  const res = await api().patch(`/api/v1/admin/feedback/${id}`).set(full).send({ status: 'resolved', note: 'Fixed in 1.0.4' });
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.feedback.status, res.body.feedback.adminNote], ['resolved', 'Fixed in 1.0.4']);
  assert.ok(res.body.feedback.resolvedAt);
  assert.equal((await api().get('/api/v1/admin/feedback?status=resolved').set(full)).body.total, 1);
  assert.equal((await auditRows('feedback.resolved')).length, 1);
  const re = await api().patch(`/api/v1/admin/feedback/${id}`).set(full).send({ status: 'open' });
  assert.deepEqual([re.body.feedback.status, re.body.feedback.resolvedAt], ['open', null]);
  assert.equal((await auditRows('feedback.reopened')).length, 1);
  assert.equal((await api().patch('/api/v1/admin/feedback/99999').set(full).send({ status: 'resolved' })).status, 404);
});

// ---------------------------------------------------------------- App config + Donate URL

test('meta/config: donateUrl (admin setting wins over DONATE_URL) and Coming Soon features; donate URL audited', async () => {
  const m = await api().get('/api/v1/meta/config');
  assert.equal(m.body.donateUrl, '');
  assert.deepEqual(m.body.features, { leaderboards: 'coming_soon', customizeAvatar: 'coming_soon' });
  const full = await admin();
  assert.equal((await api().put('/api/v1/admin/home/donate-url').set(full).send({ donateUrl: 'javascript:alert(1)' })).status, 400);
  assert.equal((await api().put('/api/v1/admin/home/donate-url').set(full).send({ donateUrl: 'ftp://example.org' })).status, 400);
  const put = await api().put('/api/v1/admin/home/donate-url').set(full).send({ donateUrl: 'https://donate.example.org/loyadham' });
  assert.deepEqual([put.status, put.body.donateUrl, put.body.isDefault], [200, 'https://donate.example.org/loyadham', false]);
  assert.equal((await api().get('/api/v1/meta/config')).body.donateUrl, 'https://donate.example.org/loyadham');
  assert.deepEqual(details((await auditRows('donate_url.changed'))[0]), { from: '', to: 'https://donate.example.org/loyadham' });
  await api().put('/api/v1/admin/home/donate-url').set(full).send({ donateUrl: '' });
  assert.equal((await api().get('/api/v1/meta/config')).body.donateUrl, '', 'empty hides the button');
  assert.equal((await auditRows('donate_url.changed')).length, 2);
  assert.equal((await api().get('/api/v1/admin/home/donate-url').set(await admin('content_editor', 'ed@example.org'))).status, 403);
});

test('api-docs lists the Home tab endpoints', async () => {
  const d = (await api().get('/api-docs.json')).body;
  for (const p of ['/profiles/{id}/spin', '/profiles/{id}/streak', '/profiles/{id}/streak/check-in', '/profiles/{id}/streak/claim', '/news', '/feedback',
    '/admin/home/spin-segments', '/admin/home/streak-bonus', '/admin/home/donate-url', '/admin/news', '/admin/news/{id}', '/admin/feedback', '/admin/feedback/{id}']) {
    assert.ok(d.paths[p], p);
  }
});
