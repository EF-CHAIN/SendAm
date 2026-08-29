const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { REQUIRED_TABLES } = require('../scripts/validate-production-db');
const {
  runRestoreDrill,
  validateBackupFreshness,
  readBackupMetadata,
  validateRedisQueue,
} = require('../scripts/verify-restore-drill');

const migrationDirectory = path.resolve(__dirname, '../prisma/migrations');

const successfulClient = () => ({
  ended: false,
  async connect() {},
  async end() { this.ended = true; },
  async query(sql) {
    if (sql === 'SHOW server_version') return { rows: [{ server_version: '16.4' }] };
    if (sql.includes('to_regclass')) return { rows: [{ name: '_prisma_migrations' }] };
    if (sql.includes('finished_at IS NULL')) return { rows: [] };
    if (sql.includes('SELECT migration_name')) {
      return {
        rows: fs.readdirSync(migrationDirectory, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => ({ migration_name: entry.name })),
      };
    }
    if (sql.includes('pg_catalog.pg_tables')) {
      return { rows: REQUIRED_TABLES.map((tablename) => ({ tablename })) };
    }
    if (sql.includes('count(*)::int')) return { rows: [{ count: 7 }] };
    if (sql.includes('encryptedSecretKey')) {
      return { rows: [{ id: 'wallet_1', encryptedSecretKey: 'ciphertext' }] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  },
});

test('reads backup metadata from JSON without exposing provider details', () => {
  assert.deepEqual(
    readBackupMetadata({ BACKUP_METADATA_JSON: '{"backupId":"backup-123","completedAt":"2026-08-20T09:00:00.000Z"}' }),
    { backupId: 'backup-123', completedAt: '2026-08-20T09:00:00.000Z' },
  );
});

test('fails stale backups against the configured RPO threshold', () => {
  assert.throws(
    () => validateBackupFreshness({
      completedAt: '2026-08-19T00:00:00.000Z',
      now: new Date('2026-08-20T09:00:00.000Z'),
      maxAgeMinutes: 60,
    }),
    /Latest backup is stale/,
  );
});

test('summarizes restored Redis queue state without payloads', async () => {
  const calls = [];
  class FakeRedis {
    constructor(url) { this.url = url; }
    async llen(key) { calls.push(key); return 2; }
    async zcard(key) { calls.push(key); return 3; }
    async quit() {}
  }

  const result = await validateRedisQueue({
    redisUrl: 'redis://localhost:6379',
    maxAgeMinutes: 30,
    redisFactory: FakeRedis,
  });

  assert.equal(result.checked, true);
  assert.equal(result.waitingJobs, 2);
  assert.equal(result.delayedJobs, 3);
  assert.equal(result.failedJobs, 3);
  assert.deepEqual(calls, ['bull:whatsapp:wait', 'bull:whatsapp:delayed', 'bull:whatsapp:failed']);
});

test('runs schema, representative data, wallet decryptability, RPO, and RTO checks', async () => {
  const clients = [successfulClient(), successfulClient()];
  const result = await runRestoreDrill({
    env: {
      DRILL_DATABASE_URL: 'postgresql://sendam:secret@localhost/drill',
      LATEST_BACKUP_ID: 'backup-123',
      LATEST_BACKUP_COMPLETED_AT: '2026-08-20T08:30:00.000Z',
      RESTORE_DRILL_MAX_BACKUP_AGE_MINUTES: '120',
      RESTORE_DRILL_RTO_OBJECTIVE_MINUTES: '60',
    },
    now: new Date('2026-08-20T09:00:00.000Z'),
    clientFactory: () => clients.shift(),
    decrypt: (value) => {
      assert.equal(value, 'ciphertext');
      return 'plaintext-secret';
    },
  });

  assert.equal(result.event, 'restore_drill_passed');
  assert.equal(result.backupId, 'backup-123');
  assert.equal(result.rpoMinutes, 30);
  assert.equal(result.representativeCounts.User, 7);
  assert.equal(result.walletDecrypt.checked, 1);
  assert.equal(result.evidenceRedacted, true);
});
