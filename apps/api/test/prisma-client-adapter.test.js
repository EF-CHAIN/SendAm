const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Files that construct a PrismaClient. The schema datasource carries no
// inline url (it lives in prisma.config.ts for CLI commands), so in Prisma 7
// a bare `new PrismaClient()` fails at runtime with
// PrismaClientInitializationError. Every construction must pass the PrismaPg
// adapter, as src/common/prisma.js does.
const PRISMA_CLIENT_FILES = [
  'src/common/prisma.js',
  'prisma/seed.js',
  'test/seed.idempotency.test.js',
];

for (const file of PRISMA_CLIENT_FILES) {
  test(`PrismaClient in ${file} is constructed with the pg adapter`, () => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');

    const constructions = source.match(/new PrismaClient\(/g) ?? [];
    assert.ok(constructions.length > 0, `${file} should construct a PrismaClient`);

    // No bare constructor: `new PrismaClient()` or `new PrismaClient({})`
    // without an adapter crashes at runtime.
    assert.ok(
      !/new PrismaClient\(\s*\)/.test(source),
      `${file} has a bare new PrismaClient() — pass a PrismaPg adapter (new PrismaClient({ adapter }))`
    );

    // Every construction must pass an adapter (accepts both `{ adapter }`
    // shorthand and `{ adapter: new PrismaPg(...) }`).
    assert.ok(
      /new PrismaClient\(\s*\{\s*adapter\s*(:|\})/.test(source),
      `${file} must construct PrismaClient with a PrismaPg adapter (new PrismaClient({ adapter }))`
    );
  });
}
