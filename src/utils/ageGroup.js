// Age categories exactly as defined in contract Section 3.3.
const AGE_GROUPS = [
  { key: 'Shishu',              min: 0,  max: 4 },
  { key: 'Bals/Balikas A',      min: 5,  max: 7 },
  { key: 'Bals/Balikas B',      min: 8,  max: 9 },
  { key: 'Bals/Balikas C',      min: 10, max: 12 },
  { key: 'Kishors/Kishoris A',  min: 13, max: 15 },
  { key: 'Kishors/Kishoris B',  min: 16, max: 18 },
  { key: 'Yuvak/Yuvatis A',     min: 19, max: 35 },
  { key: 'Yuvaks/Yuvatis B',    min: 36, max: 55 },
  { key: 'Vadil',               min: 56, max: 200 },
];
const AGE_GROUP_KEYS = AGE_GROUPS.map((g) => g.key);

const { etDate } = require('./time');

/** Full years between a DOB (YYYY-MM-DD) and a calendar date (default: today in Eastern Time). */
function ageOn(dob, onDate = etDate()) {
  const [by, bm, bd] = dob.split('-').map(Number);
  const [ty, tm, td] = onDate.split('-').map(Number);
  let age = ty - by;
  if (tm < bm || (tm === bm && td < bd)) age -= 1;
  return age;
}

function ageGroupForAge(age) {
  const g = AGE_GROUPS.find((x) => age >= x.min && age <= x.max);
  return g ? g.key : null;
}

function ageGroupForDob(dob, onDate) {
  return ageGroupForAge(ageOn(dob, onDate));
}

/** Valid, real calendar date in the past (YYYY-MM-DD)? */
function isValidDob(dob, onDate = etDate()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return false;
  const [y, m, d] = dob.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return false;
  return dob <= onDate && y >= 1900;
}

module.exports = { AGE_GROUPS, AGE_GROUP_KEYS, ageOn, ageGroupForAge, ageGroupForDob, isValidDob };
