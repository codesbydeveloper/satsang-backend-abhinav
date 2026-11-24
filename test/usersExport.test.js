// Part G (client): GET /admin/users/export.csv (Full Admin, same rows/filters/sort as the Users table) and
// GET /export/sheet (Google Sheet, X-Export-Key = SHEET_EXPORT_KEY, no CORS).
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const h = require('./helpers');
const config = require('../src/config');
const { createApp } = require('../src/app');
const { csvCell, localDateTime } = require('../src/utils/usersTable');
const { api, bearer } = h;

const KEY = 'k'.repeat(24) + 'Z9'.repeat(12);   // 48 characters
beforeEach(async () => { await h.resetDb(); delete process.env.SHEET_EXPORT_KEY; });
after(() => { delete process.env.SHEET_EXPORT_KEY; return h.pool.end(); });

const addChild = async (p, username, years) => {
  const r = await api().post('/api/v1/profiles').set(p.auth).send({ username, avatarId: 2, dob: h.dobYearsAgo(years, 30), parentalConsent: true });
  if (r.status !== 201) throw new Error('child failed: ' + JSON.stringify(r.body));
  return r.body.profile;
};
const setName = (accountId, first, last) => h.query('UPDATE accounts SET first_name = ?, last_name = ? WHERE id = ?', [first, last, accountId]);
const setCountry = (profileId, c) => h.query('UPDATE profiles SET country = ? WHERE id = ?', [c, profileId]);

// Anil (adult, IN; name with a comma and quotes), Zara (adult, US; name that looks like a formula),
// Priya (parent) with kid_a (12, IN, pending) and a Gujarati-named kid_b (9, GB, interested).
async function seed() {
  const anil = await h.adultLogin('anil@example.org', 'anil_a');
  const zara = await h.adultLogin('zara@example.org', 'zara_z');
  const p = await h.parentLogin('parent@example.org');
  const kidA = await addChild(p, 'kid_a', 12);
  const kidB = await addChild(p, 'kid_b', 9);
  await h.query('UPDATE profiles SET username = ? WHERE id = ?', ['કૃષ્ણ_b', kidB.id]);
  await setName(anil.account.id, 'Shah, "Anil"', 'Kumar'); await setName(zara.account.id, '=HYPERLINK("x")', null); await setName(p.account.id, 'Priya', 'Mehta');
  await setCountry(anil.profiles[0].id, 'IN'); await setCountry(zara.profiles[0].id, 'US');
  await setCountry(kidA.id, 'IN'); await setCountry(kidB.id, 'GB');
  await api().put(`/api/v1/profiles/${kidA.id}/student-status`).set(p.auth).send({ enrolled: true });
  await api().put(`/api/v1/profiles/${kidB.id}/student-status`).set(p.auth).send({ enrolled: false, interested: true });
  const token = (await h.adminLogin(await h.makeAdmin('boss@example.org'))).token;
  return { token, anil, zara, p, kidA, kidB };
}

// Minimal RFC 4180 parser for the checks (quoted cells, "" escapes, CRLF).
function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; continue; }
    if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const getCsv = (token, params = {}) => api().get('/api/v1/admin/users/export.csv').set(bearer(token)).query(params).buffer(true).parse((res, cb) => {
  const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks)));
});
const HEADER = ['Name', 'Username', 'Account type', 'Country', 'DOB', 'Age group', 'Email', 'Class status', `Joined (${config.dashboardTimeZone})`, 'Account ID', 'Profile ID', 'Parent account ID'];

test('CSV: Full Admin only', async () => {
  await h.resetDb();
  assert.equal((await api().get('/api/v1/admin/users/export.csv')).status, 401);
  const editor = (await h.adminLogin(await h.makeAdmin('editor@example.org', 'content_editor'))).token;
  assert.equal((await getCsv(editor)).status, 403);
});

test('CSV: BOM, headers, file name, family grouping, ids, escaping and Gujarati', async () => {
  const s = await seed();
  const r = await getCsv(s.token);
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /^text\/csv; charset=utf-8/);
  const day = localDateTime(new Date().toISOString()).slice(0, 10);
  assert.equal(r.headers['content-disposition'], `attachment; filename="satsang-spark-users-${day}.csv"`);
  assert.deepEqual([...r.body.subarray(0, 3)], [0xEF, 0xBB, 0xBF], 'UTF-8 BOM');
  const text = r.body.toString('utf8');
  assert.ok(text.includes('\r\n'));
  const rows = parseCsv(text.slice(1));
  assert.deepEqual(rows[0], HEADER);
  const data = rows.slice(1);
  assert.equal(data.length, 5);
  // newest family first: the parent row, then its two children, linked by the ids
  const pid = String(s.p.account.id);
  assert.deepEqual(data.slice(0, 3).map((x) => x[2]), ['Parent', 'Child', 'Child']);
  assert.deepEqual(data[0].slice(0, 3), ['Priya Mehta', '', 'Parent']);
  assert.deepEqual(data[0].slice(9), [pid, '', '']);
  for (const kid of data.slice(1, 3)) {
    assert.equal(kid[0], '', 'children have no name');
    assert.equal(kid[6], 'parent@example.org', 'child rows carry the parent email');
    assert.equal(kid[9], pid); assert.equal(kid[11], pid);
  }
  const kidB = data.find((x) => x[10] === String(s.kidB.id));
  assert.deepEqual(kidB.slice(1, 8), ['કૃષ્ણ_b', 'Child', 'United Kingdom', h.dobYearsAgo(9, 30), 'Bals/Balikas B', 'parent@example.org', 'Interested']);
  assert.match(kidB[8], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  const anil = data.find((x) => x[1] === 'anil_a');
  assert.deepEqual(anil.slice(0, 8), ['Shah, "Anil" Kumar', 'anil_a', 'Adult', 'India', h.dobYearsAgo(30), 'Yuvaks/Yuvatis A', 'anil@example.org', 'Not answered']);
  assert.deepEqual(anil.slice(9), [String(s.anil.account.id), String(s.anil.profiles[0].id), '']);
  assert.ok(text.includes('"Shah, ""Anil"" Kumar"'), 'comma and quotes are quoted and doubled');
  assert.equal(data.find((x) => x[1] === 'zara_z')[0], `'=HYPERLINK("x")`, 'a formula-looking name gets an apostrophe');
  assert.equal(/password|hash|Secret123|token/i.test(text), false);
});

test('CSV: same filters and sort as the table; audited with count and filters only', async () => {
  const s = await seed();
  // a matching child brings its parent row first; the other child is left out
  let data = parseCsv((await getCsv(s.token, { country: 'GB' })).body.toString('utf8').slice(1)).slice(1);
  assert.deepEqual(data.map((x) => [x[2], x[1]]), [['Parent', ''], ['Child', 'કૃષ્ણ_b']]);
  data = parseCsv((await getCsv(s.token, { accountType: 'adult', sort: 'username', order: 'asc' })).body.toString('utf8').slice(1)).slice(1);
  assert.deepEqual(data.map((x) => x[1]), ['anil_a', 'zara_z']);
  data = parseCsv((await getCsv(s.token, { classStatus: 'pending_verification' })).body.toString('utf8').slice(1)).slice(1);
  assert.deepEqual(data.map((x) => x[1]), ['', 'kid_a']);
  assert.equal((await getCsv(s.token, { sort: 'nope' })).status, 400);

  const a = await h.query("SELECT * FROM audit_log WHERE action = 'users.exported' ORDER BY id");
  assert.equal(a.length, 3);
  const d = typeof a[0].details === 'string' ? JSON.parse(a[0].details) : a[0].details;
  assert.deepEqual(Object.keys(d).sort(), ['count', 'filters']);
  assert.equal(d.count, 2);
  assert.deepEqual(d.filters, { country: 'GB', sort: 'joined', order: 'desc' });
  assert.equal(/example\.org|anil|kid_|Priya/i.test(JSON.stringify(a.map((x) => x.details))), false, 'no emails, names or usernames in the audit');
});

test('csvCell: RFC 4180 quoting and formula guard', () => {
  assert.equal(csvCell(null), '');
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell(42), '42');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('two\nlines'), '"two\nlines"');
  assert.equal(csvCell(' padded'), '" padded"');
  assert.equal(csvCell('+1'), "'+1");
  assert.equal(csvCell('@x'), "'@x");
  assert.equal(csvCell('-2'), "'-2");
});

// ---- Google Sheet ----
const sheet = (key) => { const r = api().get('/api/v1/export/sheet'); return key === undefined ? r : r.set('X-Export-Key', key); };

test('sheet: 404 while SHEET_EXPORT_KEY is empty, even with a key', async () => {
  assert.equal((await sheet()).status, 404);
  assert.equal((await sheet('anything')).status, 404);
});

test('sheet: 401 without the right key; admin tokens are not accepted', async () => {
  process.env.SHEET_EXPORT_KEY = KEY;
  const s = await seed();
  for (const r of [await sheet(), await sheet('wrong'), await sheet(KEY + 'x'), await sheet(KEY.slice(0, -1)),
    await api().get('/api/v1/export/sheet').set(bearer(s.token))]) {
    assert.equal(r.status, 401); assert.equal(r.body.error.code, 'EXPORT_KEY_INVALID');
  }
  assert.equal((await h.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'sheet.export'"))[0].n, 0);
});

test('sheet: table columns only, grouped rows, audited with the count only', async () => {
  process.env.SHEET_EXPORT_KEY = KEY;
  const s = await seed();
  const r = await sheet(KEY);
  assert.equal(r.status, 200);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.deepEqual(Object.keys(r.body).sort(), ['columns', 'generatedAt', 'rows']);
  assert.match(r.body.generatedAt, /Z$/);
  assert.deepEqual(r.body.columns.map((c) => c.key), ['name', 'username', 'accountType', 'country', 'dob', 'ageGroup', 'email', 'classStatus', 'joined', 'accountId', 'profileId', 'parentAccountId']);
  assert.deepEqual(r.body.columns.map((c) => c.label).slice(0, 9), ['Name', 'Username', 'Account type', 'Country', 'DOB', 'Age group', 'Email', 'Class status', 'Joined']);
  assert.deepEqual(r.body.columns.find((c) => c.key === 'dob').type, 'date');
  assert.deepEqual(r.body.columns.find((c) => c.key === 'joined').type, 'datetime');
  const rows = r.body.rows;
  assert.equal(rows.length, 5);
  assert.ok(rows.every((x) => Array.isArray(x) && x.length === 12));
  const col = (k) => r.body.columns.findIndex((c) => c.key === k);
  assert.deepEqual(rows.slice(0, 3).map((x) => x[col('accountType')]), ['Parent', 'Child', 'Child']);
  assert.equal(rows[0][col('username')], null);
  assert.equal(rows[0][col('parentAccountId')], null);
  assert.deepEqual(rows.slice(1, 3).map((x) => x[col('parentAccountId')]), [s.p.account.id, s.p.account.id]);
  const kidB = rows.find((x) => x[col('profileId')] === s.kidB.id);
  assert.equal(kidB[col('username')], 'કૃષ્ણ_b');
  assert.equal(kidB[col('email')], 'parent@example.org');
  assert.equal(kidB[col('dob')], h.dobYearsAgo(9, 30));
  assert.match(kidB[col('joined')], /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.equal(/password|hash|pin|token|Secret123|gender|phone/i.test(JSON.stringify(r.body)), false);

  const a = await h.query("SELECT * FROM audit_log WHERE action = 'sheet.export'");
  assert.equal(a.length, 1);
  assert.equal(a[0].admin_id, null);
  const d = typeof a[0].details === 'string' ? JSON.parse(a[0].details) : a[0].details;
  assert.deepEqual(d, { count: 5 });
});

test('sheet: no CORS headers, even for an allowed Admin Panel origin', async () => {
  process.env.SHEET_EXPORT_KEY = KEY;
  const saved = config.corsOrigins;
  config.corsOrigins = ['https://panel.example'];
  try {
    const app = createApp();
    const panel = await request(app).get('/api/v1/admin/users').set('Origin', 'https://panel.example');
    assert.equal(panel.headers['access-control-allow-origin'], 'https://panel.example', 'control: CORS works elsewhere');
    assert.match(panel.headers['access-control-expose-headers'] || '', /Content-Disposition/i, 'the panel can read the CSV file name');
    const r = await request(app).get('/api/v1/export/sheet').set('Origin', 'https://panel.example').set('X-Export-Key', KEY);
    assert.equal(r.status, 200);
    assert.equal(r.headers['access-control-allow-origin'], undefined);
    const pre = await request(app).options('/api/v1/export/sheet').set('Origin', 'https://panel.example').set('Access-Control-Request-Method', 'GET').set('Access-Control-Request-Headers', 'x-export-key');
    assert.equal(pre.headers['access-control-allow-origin'], undefined);
  } finally { config.corsOrigins = saved; }
});
