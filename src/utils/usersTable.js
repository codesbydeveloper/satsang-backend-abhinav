const { z } = require('zod');
const config = require('../config');
const { query } = require('../db');
const { AGE_GROUP_KEYS, ageGroupLabel } = require('./ageGroup');
const { toIso, toSql } = require('./time');
const { STUDENT_STATUSES } = require('./studentStatus');

// ---- The Users table (client 23 Nov 2026) ----
// One row per playable profile, grouped by account ("family"): first the account row (an adult's own profile, or a
// parent account, which has no profile of its own), then each child profile as its own row (parentAccountId set).
// A child has no email: its row carries the parent's email with isParentEmail: true. Child profiles have no name.
// DOB is returned here (Full Admin only) and never by the app API. Never password hashes or the PIN.
//
// Filters match single rows. A family is listed when any of its rows matches; its account row always comes first
// (matched: false → the panel greys it) and only the matching children follow. Sorting orders families by their
// account row, and the children inside a family by the same column. page/pageSize/totalAccounts count families.
//
// Used by GET /admin/users (one page), GET /admin/users/export.csv and GET /export/sheet (every family).

const like = (s) => `%${s.replace(/[\\%_]/g, '\\$&')}%`;

// Old ?studentStatus= (one status or a comma list, e.g. the dashboard's pending_verification,interested) still works.
const statusList = z.string().transform((s) => [...new Set(s.split(',').map((x) => x.trim()).filter(Boolean))])
  .pipe(z.array(z.enum(STUDENT_STATUSES)).min(1));
// The panel's Class Status filter. interested includes interest_confirmed; not_enrolled includes not_asked
// (never answered), so every profile falls under exactly one of the four.
const CLASS_STATUS = {
  verified: ['verified'], pending_verification: ['pending_verification'],
  interested: ['interested', 'interest_confirmed'], not_enrolled: ['not_enrolled', 'not_asked'],
};
const AG_ORDER = `NULLIF(FIELD(h.age_group, ${AGE_GROUP_KEYS.map((k) => `'${k.replace(/'/g, "''")}'`).join(', ')}), 0)`;
const SORTS = {   // sql: on the family's account row (h); key(): the same for the children inside a family
  name: { sql: 'LOWER(h.name)', key: (r) => r.name?.toLowerCase() ?? null },
  username: { sql: 'LOWER(h.username)', key: (r) => r.username?.toLowerCase() ?? null },
  accountType: { sql: 'h.row_type', key: (r) => r.row_type },
  country: { sql: 'h.country', key: (r) => r.country },
  dob: { sql: 'h.dob', key: (r) => r.dob },
  ageGroup: { sql: AG_ORDER, key: (r) => { const i = AGE_GROUP_KEYS.indexOf(r.age_group); return i < 0 ? null : i; } },
  email: { sql: 'LOWER(h.email)', key: (r) => r.email.toLowerCase() },
  // the playable profile's Sparks balance (profile_sparks; 0 before its first Sparks). A parent account row has no
  // profile (null), so parent families sort after the others, with their children ordered inside by balance.
  sparks: { sql: 'h.sparks_balance', key: (r) => (r.sparks_balance == null ? null : Number(r.sparks_balance)) },
  joined: { sql: 'h.joined', key: (r) => r.joined },
};
// Filters + sort (shared by the list and the CSV export).
const filterShape = {
  q: z.string().trim().max(100).default(''),
  country: z.string().trim().regex(/^[A-Za-z]{2}$/).transform((s) => s.toUpperCase()).optional(),
  ageGroup: z.enum(AGE_GROUP_KEYS).optional(),
  accountType: z.enum(['adult', 'parent', 'child']).optional(),
  classStatus: z.enum(['all', ...Object.keys(CLASS_STATUS)]).default('all'),
  studentStatus: statusList.optional(),
  // accounts created at/after this instant (account rows only): the dashboard's "New registrations today"
  joinedSince: z.string().datetime({ offset: true }).transform((s) => new Date(s)).optional(),
  sort: z.enum(Object.keys(SORTS)).default('joined'),
  order: z.enum(['asc', 'desc']).optional(),   // default: newest first for joined, most Sparks first for sparks, A→Z otherwise
};
const filterSchema = z.object(filterShape);
const listSchema = z.object({
  ...filterShape,
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

// Every displayed row: account rows (with the adult's own profile, if any) + child profile rows.
const ROWS = `WITH r AS (
  SELECT a.id AS account_id, NULL AS parent_account_id, own.id AS profile_id, 0 AS is_child_row,
         CAST(a.account_type AS CHAR(10)) AS row_type, NULLIF(TRIM(CONCAT_WS(' ', a.first_name, a.last_name)), '') AS name,
         own.username, own.country, own.dob, own.age_group, own.age_group_override, own.student_status,
         a.email, a.email_verified_at, a.created_at AS joined,
         CASE WHEN own.id IS NULL THEN NULL ELSE COALESCE(ops.balance, 0) END AS sparks_balance
    FROM accounts a
    LEFT JOIN profiles own ON own.id = (SELECT MIN(x.id) FROM profiles x WHERE x.account_id = a.id AND x.is_child = 0)
    LEFT JOIN profile_sparks ops ON ops.profile_id = own.id
  UNION ALL
  SELECT a.id, a.id, c.id, 1, 'child', NULL, c.username, c.country, c.dob, c.age_group, c.age_group_override, c.student_status,
         a.email, a.email_verified_at, c.created_at, COALESCE(cps.balance, 0)
    FROM profiles c JOIN accounts a ON a.id = c.account_id LEFT JOIN profile_sparks cps ON cps.profile_id = c.id WHERE c.is_child = 1)`;

/**
 * The Users table rows for the given filters and sort. page/pageSize: one page of families; pageSize null: every
 * family. Returns { order, totalAccounts, totalRows, rows } (rows in rowView shape).
 */
async function queryUsers({ q = '', country, ageGroup, accountType, classStatus = 'all', studentStatus, joinedSince, sort = 'joined', order, page = 1, pageSize = null } = {}) {
  order = order || (sort === 'joined' || sort === 'sparks' ? 'desc' : 'asc');
  const conds = []; const params = [];
  if (q) { conds.push('(LOWER(r.name) LIKE ? OR LOWER(r.username) LIKE ? OR LOWER(r.email) LIKE ?)'); const l = like(q.toLowerCase()); params.push(l, l, l); }
  if (country) { conds.push('r.country = ?'); params.push(country); }
  if (ageGroup) { conds.push('r.age_group = ?'); params.push(ageGroup); }
  if (accountType) { conds.push('r.row_type = ?'); params.push(accountType); }
  if (joinedSince) { conds.push('(r.is_child_row = 0 AND r.joined >= ?)'); params.push(toSql(joinedSince)); }
  for (const list of [classStatus !== 'all' && CLASS_STATUS[classStatus], studentStatus]) {
    if (list) { conds.push(`r.student_status IN (${list.map(() => '?').join(', ')})`); params.push(...list); }
  }
  const match = conds.length ? conds.join(' AND ') : '1';
  const s = SORTS[sort]; const dir = order === 'desc' ? 'DESC' : 'ASC';

  const fam = `${ROWS}, fam AS (SELECT DISTINCT r.account_id FROM r WHERE ${match})`;
  const total = (await query(`${fam} SELECT COUNT(*) AS n FROM fam`, params))[0].n;
  // rows matching the filters themselves (greyed parent rows not counted): equals the dashboard card numbers
  const totalRows = (await query(`${ROWS} SELECT COUNT(*) AS n FROM r WHERE ${match}`, params))[0].n;
  const limit = pageSize ? ' LIMIT ? OFFSET ?' : '';
  const heads = await query(
    `${fam} SELECT h.account_id FROM r h JOIN fam f ON f.account_id = h.account_id WHERE h.is_child_row = 0
      ORDER BY (${s.sql}) IS NULL, ${s.sql} ${dir}, h.account_id ${sort === 'joined' ? dir : 'DESC'}${limit}`,
    pageSize ? [...params, pageSize, (page - 1) * pageSize] : params);
  const ids = heads.map((x) => x.account_id);

  let rows = [];
  if (ids.length) {
    // every family at once for an export: the family filter is a JOIN on fam instead of a long IN list
    const all = pageSize
      ? await query(`${ROWS} SELECT r.*, (${match}) AS matched FROM r WHERE r.account_id IN (?)`, [...params, ids])
      : await query(`${fam} SELECT r.*, (${match}) AS matched FROM r JOIN fam f ON f.account_id = r.account_id`, [...params, ...params]);
    const byAccount = new Map();
    for (const r of all) { if (!byAccount.has(r.account_id)) byAccount.set(r.account_id, []); byAccount.get(r.account_id).push(r); }
    const cmp = (x, y) => {   // children inside a family: same column and direction, empty values last, then username
      const a = s.key(x); const b = s.key(y);
      if (a === b || (a == null && b == null)) return (x.username || '').localeCompare(y.username || '') || x.profile_id - y.profile_id;
      if (a == null) return 1;
      if (b == null) return -1;
      return (a < b ? -1 : 1) * (dir === 'DESC' ? -1 : 1);
    };
    rows = ids.flatMap((id) => {
      const family = byAccount.get(id) || [];
      return [family.find((r) => !r.is_child_row), ...family.filter((r) => r.is_child_row && r.matched).sort(cmp)];
    }).filter(Boolean).map(rowView);
  }
  return { order, totalAccounts: total, totalRows, rows };
}

function rowView(r) {
  const child = !!r.is_child_row;
  return {
    accountId: r.account_id, parentAccountId: child ? r.parent_account_id : null, profileId: r.profile_id,
    accountType: r.row_type, isChild: child, name: r.name, username: r.username, country: r.country, dob: r.dob,
    ageGroup: ageGroupLabel(r.age_group), ageGroupKey: r.age_group, ageGroupOverridden: !!r.age_group_override,
    email: r.email, isParentEmail: child, studentStatus: r.profile_id ? r.student_status : null,
    emailVerified: !!r.email_verified_at, joined: toIso(r.joined), createdAt: r.joined,
    // the profile's real Sparks balance (0 before its first Sparks); null on a parent account row (no profile)
    sparksBalance: r.profile_id ? Number(r.sparks_balance ?? 0) : null,
    matched: !!r.matched,   // false: an account row shown only because one of its children matched
  };
}

// ---- Exports (CSV + Google Sheet) ----
// Exactly the Users table's columns, in the panel's order, plus the three ids that keep families linked. Nothing
// else ever leaves in an export (no hashes, tokens, phone, gender, verification state).
const ACCOUNT_TYPE_LABEL = { adult: 'Adult', parent: 'Parent', child: 'Child' };
// Same wording as the panel (satsang-admin src/studentStatus.jsx).
const STUDENT_STATUS_LABEL = {
  not_asked: 'Not answered', pending_verification: 'Pending verification', verified: 'Verified student',
  interested: 'Interested', interest_confirmed: 'Interested – confirmed', not_enrolled: 'Not enrolled',
};
let regionNames = null;
try { regionNames = new Intl.DisplayNames(['en'], { type: 'region' }); } catch { /* no ICU data: codes are used */ }
const countryName = (code) => { if (!code) return null; try { return regionNames?.of(code) || code; } catch { return code; } };

// type: how the Google Sheet script formats the column (string | date | datetime | number).
const EXPORT_COLUMNS = [
  { key: 'name', label: 'Name', type: 'string', value: (r) => r.name },
  { key: 'username', label: 'Username', type: 'string', value: (r) => r.username },
  { key: 'accountType', label: 'Account type', type: 'string', value: (r) => ACCOUNT_TYPE_LABEL[r.accountType] || r.accountType },
  { key: 'country', label: 'Country', type: 'string', value: (r) => countryName(r.country) },
  { key: 'dob', label: 'DOB', type: 'date', value: (r) => r.dob || null },
  { key: 'ageGroup', label: 'Age group', type: 'string', value: (r) => r.ageGroup },
  { key: 'email', label: 'Email', type: 'string', value: (r) => r.email },
  { key: 'classStatus', label: 'Class status', type: 'string', value: (r) => (r.studentStatus ? STUDENT_STATUS_LABEL[r.studentStatus] || r.studentStatus : null) },
  // the profile's Sparks balance (0 without Sparks); empty on a parent account row (no profile of its own)
  { key: 'sparks', label: 'Sparks', type: 'number', value: (r) => r.sparksBalance },
  { key: 'joined', label: 'Joined', type: 'datetime', value: (r) => r.joined || null },
  { key: 'accountId', label: 'Account ID', type: 'number', value: (r) => r.accountId },
  { key: 'profileId', label: 'Profile ID', type: 'number', value: (r) => r.profileId },
  { key: 'parentAccountId', label: 'Parent account ID', type: 'number', value: (r) => r.parentAccountId },
];
/** Rows as arrays in EXPORT_COLUMNS order (null for empty cells). */
const exportRows = (rows) => rows.map((r) => EXPORT_COLUMNS.map((c) => { const v = c.value(r); return v === undefined || v === '' ? null : v; }));

// "YYYY-MM-DD HH:MM" in DASHBOARD_TIMEZONE (spreadsheet apps read it as a date and time).
function localDateTime(iso, timeZone = config.dashboardTimeZone) {
  if (!iso) return null;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

// One CSV cell (RFC 4180). Text that a spreadsheet would run as a formula (= + - @, tab, CR first) gets a leading
// apostrophe, so a username or name can never become a formula on the admin's computer.
function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The CSV file: UTF-8 BOM (Excel then shows Gujarati correctly), CRLF line ends. Joined in DASHBOARD_TIMEZONE. */
function toCsv(rows) {
  const joinedAt = EXPORT_COLUMNS.findIndex((c) => c.key === 'joined');
  const header = EXPORT_COLUMNS.map((c) => (c.key === 'joined' ? `Joined (${config.dashboardTimeZone})` : c.label));
  const lines = [header, ...exportRows(rows).map((cells) => cells.map((v, i) => (i === joinedAt ? localDateTime(v) : v)))];
  return '﻿' + lines.map((cells) => cells.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

module.exports = { CLASS_STATUS, SORTS, filterSchema, listSchema, queryUsers, rowView, EXPORT_COLUMNS, exportRows, toCsv, csvCell, localDateTime };
