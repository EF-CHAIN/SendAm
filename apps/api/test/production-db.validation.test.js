const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  validateConnectionPolicy,
  validateDatabase,
  REQUIRED_TABLES,
} = require('../scripts/validate-production-db');

const migrationDirectory = path.resolve(__dirname, '../prisma/migrations');

const successfulClient = (overrides = {}) => {
  const client = {
    connected: false,
    ended: false,
    async connect() { this.connected = true; },
    async end() { this.ended = true; },
    async query(sql) {
      if (sql === 'SHOW server_version') return { rows: [{ server_version: '16.4' }] };
      if (sql.includes('to_regclass')) return { rows: [{ name: '_prisma_migrations' }] };
      if (sql.includes('finished_at IS NULL')) return { rows: [] };
      if (sql.includes('SELECT migration_name')) {
        const fs = require('node:fs');
        return {
          rows: fs.readdirSync(migrationDirectory, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => ({ migration_name: entry.name })),
        };
      }
      if (sql.includes('pg_catalog.pg_tables')) {
        return { rows: REQUIRED_TABLES.map((tablename) => ({ tablename })) };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    ...overrides,
  };
  return client;
};

test('accepts a TLS-protected production PostgreSQL URL without exposing credentials', () => {
  const result = validateConnectionPolicy(
    'postgresql://sendam:super-secret@db.example.com/sendam?sslmode=require',
    'production',
  );
  assert.deepEqual(result, { host: 'db.example.com', database: 'sendam', local: false });
  assert.equal(JSON.stringify(result).includes('super-secret'), false);
});

test('rejects an unencrypted remote production connection', () => {
  assert.throws(
    () => validateConnectionPolicy('postgresql://sendam:secret@db.example.com/sendam', 'production'),
    /must require TLS/,
  );
});

test('validates connectivity, migration state, and required production tables', async () => {
  const client = successfulClient();
  const result = await validateDatabase({
    connectionString: 'postgresql://sendam:secret@localhost/sendam',
    nodeEnv: 'production',
    clientFactory: () => client,
  });
  assert.equal(result.event, 'database_validation_passed');
  assert.equal(result.serverVersion, '16.4');
  assert.equal(result.requiredTables, REQUIRED_TABLES.length);
  assert.equal(client.connected, true);
  assert.equal(client.ended, true);
});

test('fails validation when a migration is unfinished and still closes the connection', async () => {
  const client = successfulClient({
    async query(sql) {
      if (sql === 'SHOW server_version') return { rows: [{ server_version: '16.4' }] };
      if (sql.includes('to_regclass')) return { rows: [{ name: '_prisma_migrations' }] };
      if (sql.includes('finished_at IS NULL')) {
        return { rows: [{ migration_name: '20260802000000_broken' }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  });
  await assert.rejects(
    () => validateDatabase({
      connectionString: 'postgresql://sendam:secret@localhost/sendam',
      clientFactory: () => client,
    }),
    /Failed or rolled-back migrations/,
  );
  assert.equal(client.ended, true);
});

test('fails validation when a required table is absent', async () => {
  const client = successfulClient({
    async query(sql) {
      if (sql === 'SHOW server_version') return { rows: [{ server_version: '16.4' }] };
      if (sql.includes('to_regclass')) return { rows: [{ name: '_prisma_migrations' }] };
      if (sql.includes('finished_at IS NULL')) return { rows: [] };
      if (sql.includes('SELECT migration_name')) {
        const fs = require('node:fs');
        return {
          rows: fs.readdirSync(migrationDirectory, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => ({ migration_name: entry.name })),
        };
      }
      if (sql.includes('pg_catalog.pg_tables')) {
        return { rows: REQUIRED_TABLES.slice(1).map((tablename) => ({ tablename })) };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  });
  await assert.rejects(
    () => validateDatabase({
      connectionString: 'postgresql://sendam:secret@localhost/sendam',
      clientFactory: () => client,
    }),
    /Required tables are missing: User/,
  );
});
