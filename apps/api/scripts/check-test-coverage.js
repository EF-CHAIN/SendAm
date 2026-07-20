'use strict';

const SRC_PREFIX = 'apps/api/src/';
const TEST_PREFIX = 'apps/api/test/';

function findUnflaggedSrcChanges(changedFiles) {
  const srcChanges = changedFiles.filter((file) => file.startsWith(SRC_PREFIX));
  const hasTestChange = changedFiles.some((file) => file.startsWith(TEST_PREFIX));
  return hasTestChange ? [] : srcChanges;
}

module.exports = { findUnflaggedSrcChanges, SRC_PREFIX, TEST_PREFIX };

if (require.main === module) {
  const changedFiles = process.argv.slice(2);
  const flagged = findUnflaggedSrcChanges(changedFiles);

  if (flagged.length > 0) {
    console.error('PR changes apps/api/src/** files without any apps/api/test/** changes:');
    for (const file of flagged) console.error(`  - ${file}`);
    console.error('\nAdd or update a test under apps/api/test/ to cover this change.');
    process.exit(1);
  }

  console.log('OK: src changes are covered by test changes, or no apps/api/src files changed.');
}
