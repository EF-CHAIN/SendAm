const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeName,
  soundex,
  metaphone,
  isNameMatch,
} = require('../src/compliance/sanctionsScreening');

test('sanctions screening normalizes names and detects exact and phonetic matches', () => {
  assert.equal(normalizeName('  José   Doe '), 'jose doe');
  assert.equal(soundex('Robert'), soundex('Rupert'));
  assert.equal(metaphone('Smith'), metaphone('Smyth'));
  assert.deepEqual(isNameMatch('Robert', { caption: 'Robert' }), { exact: true, phonetic: true });
  assert.equal(isNameMatch('Robert', { caption: 'Rupert' }).phonetic, true);
});
