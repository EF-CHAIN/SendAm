/**
 * Seed idempotency test
 *
 * Verifies that running the seed function twice produces exactly the expected
 * number of rows and does NOT duplicate anything on the second run.
 *
 * This test uses a real PrismaClient, so it requires DATABASE_URL to be set.
 * If the env var is absent it skips gracefully so the CI unit-test suite
 * (which has no DB) still passes.
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Guard: skip when there is no database available
// ---------------------------------------------------------------------------

const HAS_DB = Boolean(process.env.DATABASE_URL);

if (!HAS_DB) {
  test('seed idempotency — skipped (no DATABASE_URL)', () => {
    // No assertions: the test is recorded as passing/skipped so the suite
    // doesn't fail in environments without a database.
    console.log('  ℹ  DATABASE_URL not set — skipping DB seed idempotency tests.');
  });
} else {
  // -------------------------------------------------------------------------
  // Real idempotency tests (requires a live DB with the schema applied)
  // -------------------------------------------------------------------------

  const { PrismaClient } = require('@prisma/client');

  // Import the internals we want to exercise.  The seed module exports nothing
  // by default (it calls seed() on load), so we re-export the helpers for
  // testability by requiring the pieces directly from seed.js via a small
  // re-require trick.  To keep the test hermetic we extract the helper
  // functions inline and point them at the same Prisma client.

  const DEMO_PHONES = ['+2348001110001', '+2348001110002', '+2348001110003'];

  let prisma;

  before(async () => {
    prisma = new PrismaClient();
    // Clean up any leftover seed rows from a previous interrupted test run.
    await cleanSeedRows(prisma);
  });

  after(async () => {
    await cleanSeedRows(prisma);
    await prisma.$disconnect();
  });

  test('seed: first run creates 3 users', async () => {
    await runSeed();

    const count = await prisma.user.count({
      where: { phoneNumber: { in: DEMO_PHONES } },
    });
    assert.equal(count, 3, `Expected 3 demo users, got ${count}`);
  });

  test('seed: first run creates 3 wallets', async () => {
    const count = await prisma.wallet.count({
      where: {
        user: { phoneNumber: { in: DEMO_PHONES } },
      },
    });
    assert.equal(count, 3, `Expected 3 demo wallets, got ${count}`);
  });

  test('seed: first run creates 6 transactions (3+2+1)', async () => {
    const count = await prisma.transaction.count({
      where: {
        user: { phoneNumber: { in: DEMO_PHONES } },
      },
    });
    assert.equal(count, 6, `Expected 6 demo transactions, got ${count}`);
  });

  test('seed: first run creates 3 KYC profiles', async () => {
    const count = await prisma.kycProfile.count({
      where: {
        user: { phoneNumber: { in: DEMO_PHONES } },
      },
    });
    assert.equal(count, 3, `Expected 3 KYC profiles, got ${count}`);
  });

  test('seed: second run is a no-op — row counts unchanged', async () => {
    // Run a second time.
    await runSeed();

    const [users, wallets, txs, kycs] = await Promise.all([
      prisma.user.count({ where: { phoneNumber: { in: DEMO_PHONES } } }),
      prisma.wallet.count({ where: { user: { phoneNumber: { in: DEMO_PHONES } } } }),
      prisma.transaction.count({ where: { user: { phoneNumber: { in: DEMO_PHONES } } } }),
      prisma.kycProfile.count({ where: { user: { phoneNumber: { in: DEMO_PHONES } } } }),
    ]);

    assert.equal(users, 3, `Users duplicated: expected 3, got ${users}`);
    assert.equal(wallets, 3, `Wallets duplicated: expected 3, got ${wallets}`);
    assert.equal(txs, 6, `Transactions duplicated: expected 6, got ${txs}`);
    assert.equal(kycs, 3, `KYC profiles duplicated: expected 3, got ${kycs}`);
  });

  test('seed: transactions cover all three status values', async () => {
    const statuses = await prisma.transaction.findMany({
      where: { user: { phoneNumber: { in: DEMO_PHONES } } },
      select: { status: true },
    });
    const statusSet = new Set(statuses.map((t) => t.status));
    assert.ok(statusSet.has('success'), 'No success transaction found');
    assert.ok(statusSet.has('failed'), 'No failed transaction found');
    assert.ok(statusSet.has('processing'), 'No processing transaction found');
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Spawn the seed as a child process so it uses its own Prisma instance. */
async function runSeed() {
  const { execFileSync } = require('node:child_process');
  const path = require('node:path');

  execFileSync(
    process.execPath, // node
    [path.resolve(__dirname, '../prisma/seed.js')],
    {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env },
      stdio: 'pipe', // suppress seed's console output in test runs
    }
  );
}

/** Delete only the demo rows so we don't nuke unrelated data. */
async function cleanSeedRows(db) {
  const DEMO_PHONES = ['+2348001110001', '+2348001110002', '+2348001110003'];

  // Delete in dependency order (children first).
  const users = await db.user.findMany({
    where: { phoneNumber: { in: DEMO_PHONES } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);

  if (ids.length) {
    await db.transaction.deleteMany({ where: { userId: { in: ids } } });
    await db.kycProfile.deleteMany({ where: { userId: { in: ids } } });
    await db.wallet.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  }
}
