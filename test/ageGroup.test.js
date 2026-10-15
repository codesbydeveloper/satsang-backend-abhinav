const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ageOn, ageGroupForAge, ageGroupForDob, isValidDob } = require('../src/utils/ageGroup');

test('every age maps to the contract Section 3.3 group', () => {
  const expect = { 0: 'Shishu', 4: 'Shishu', 5: 'Bals/Balikas A', 7: 'Bals/Balikas A', 8: 'Bals/Balikas B', 9: 'Bals/Balikas B',
    10: 'Bals/Balikas C', 12: 'Bals/Balikas C', 13: 'Kishors/Kishoris A', 15: 'Kishors/Kishoris A', 16: 'Kishors/Kishoris B', 18: 'Kishors/Kishoris B',
    19: 'Yuvak/Yuvatis A', 35: 'Yuvak/Yuvatis A', 36: 'Yuvaks/Yuvatis B', 55: 'Yuvaks/Yuvatis B', 56: 'Vadil', 90: 'Vadil' };
  for (const [age, g] of Object.entries(expect)) assert.equal(ageGroupForAge(Number(age)), g, `age ${age}`);
});

test('age rolls over exactly on the birthday', () => {
  assert.equal(ageOn('2010-06-15', '2023-06-14'), 12);
  assert.equal(ageOn('2010-06-15', '2023-06-15'), 13);
  assert.equal(ageGroupForDob('2010-06-15', '2023-06-14'), 'Bals/Balikas C');
  assert.equal(ageGroupForDob('2010-06-15', '2023-06-15'), 'Kishors/Kishoris A');
  assert.equal(ageOn('2000-02-29', '2023-02-28'), 22);
  assert.equal(ageOn('2000-02-29', '2023-03-01'), 23);
});

test('DOB validation', () => {
  assert.equal(isValidDob('2000-02-30'), false);
  assert.equal(isValidDob('2999-01-01'), false);
  assert.equal(isValidDob('1800-01-01'), false);
  assert.equal(isValidDob('not-a-date'), false);
  assert.equal(isValidDob('2000-02-29'), true);
});
