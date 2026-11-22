const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { promisify } = require('node:util');
const { Client } = require('pg');

const deploy = promisify(execFile);
const runner = path.resolve(__dirname, '../../scripts/run-migrations.js');
const migrationLock = 1022001;

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;

test('concurrent Prisma deploys wait for the shared advisory lock', {
  skip: !databaseUrl && 'Set MIGRATION_TEST_DATABASE_URL to a disposable PostgreSQL database',
  timeout: 120_000,
}, async () => {
  const database = new Client({ connectionString: databaseUrl });
  await database.connect();
  let runs = [];
  try {
    await database.query('SELECT pg_advisory_lock($1::bigint)', [migrationLock]);
    runs = Array.from({ length: 2 }, () => deploy(process.execPath, [runner], {
      env: { ...process.env, DATABASE_URL: databaseUrl, MIGRATION_DATABASE_URL: '' },
      timeout: 90000,
    }));
    const migrations = Promise.all(runs);
    const waiting = async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const { rows } = await database.query(
          `SELECT pid FROM pg_locks
           WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
             AND classid = 0 AND objid = $1 AND objsubid = 1 AND NOT granted`,
          [migrationLock],
        );
        if (rows.length === 2) return;
        await delay(100);
      }
      assert.fail('Both deployments should wait on the database lock');
    };
    await Promise.race([
      waiting(),
      migrations.then(() => assert.fail('Migrations completed while the advisory lock was held')),
    ]);
    await database.query('SELECT pg_advisory_unlock($1::bigint)', [migrationLock]);
    await migrations;
    const { rows } = await database.query('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [migrationLock]);
    assert.equal(rows[0].acquired, true);
  } finally {
    await database.end();
    await Promise.allSettled(runs);
  }
});
