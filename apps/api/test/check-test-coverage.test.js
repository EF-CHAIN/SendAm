const { test } = require('node:test');
const assert = require('node:assert/strict');

const { findUnflaggedSrcChanges } = require('../scripts/check-test-coverage');

test('flags src changes with no accompanying test changes', () => {
  const changed = ['apps/api/src/utils/validators.js'];
  assert.deepEqual(findUnflaggedSrcChanges(changed), ['apps/api/src/utils/validators.js']);
});

test('passes when src and test files both change', () => {
  const changed = ['apps/api/src/utils/validators.js', 'apps/api/test/validators.test.js'];
  assert.deepEqual(findUnflaggedSrcChanges(changed), []);
});

test('does not flag docs-only changes', () => {
  const changed = ['README.md', 'docs/architecture.md'];
  assert.deepEqual(findUnflaggedSrcChanges(changed), []);
});

test('does not flag frontend-only changes', () => {
  const changed = ['apps/landing/src/App.jsx', 'apps/admin/src/pages/Home.jsx'];
  assert.deepEqual(findUnflaggedSrcChanges(changed), []);
});

test('flags api src change even when an unrelated app touches its own tests', () => {
  const changed = ['apps/api/src/services/foo.js', 'apps/admin/test/foo.test.jsx'];
  assert.deepEqual(findUnflaggedSrcChanges(changed), ['apps/api/src/services/foo.js']);
});

test('passes with no changed files at all', () => {
  assert.deepEqual(findUnflaggedSrcChanges([]), []);
});
