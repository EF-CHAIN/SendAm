const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const migrationsPath = path.resolve(__dirname, '../prisma/migrations');
const REQUIRED_TABLES = ['User', 'Wallet', 'Transaction', 'RateLimitHit', 'KycWebhookEvent'];

const localMigrations = (directory = migrationsPath) => fs.readdirSync(directory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const validateConnectionPolicy = (connectionString, nodeEnv = process.env.NODE_ENV) => {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('DATABASE_URL must use postgres:// or postgresql://');
  }
  const local = ['localhost', '127.0.0.1', '::1', 'postgres'].includes(url.hostname);
  if (nodeEnv === 'production' && !local
    && !['require', 'verify-ca', 'verify-full'].includes(url.searchParams.get('sslmode'))) {
    throw new Error('Production DATABASE_URL must require TLS with sslmode=require, verify-ca, or verify-full');
  }
  return { host: url.hostname, database: url.pathname.slice(1), local };
};

const validateDatabase = async ({
  connectionString,
  nodeEnv = process.env.NODE_ENV,
  clientFactory = (config) => new Client(config),
  directory = migrationsPath,
} = {}) => {
  const target = validateConnectionPolicy(connectionString, nodeEnv);
  const client = clientFactory({ connectionString, connectionTimeoutMillis: 10000 });
  try {
    await client.connect();
    const version = await client.query('SHOW server_version');
    const migrationTable = await client.query("SELECT to_regclass('public._prisma_migrations') AS name");
    if (!migrationTable.rows[0]?.name) throw new Error('Prisma migration table is missing');

    const failed = await client.query(
      'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL',
    );
    if (failed.rows.length) {
      throw new Error(`Failed or rolled-back migrations: ${failed.rows.map((row) => row.migration_name).join(', ')}`);
    }
    const appliedResult = await client.query(
      'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
    );
    const applied = new Set(appliedResult.rows.map((row) => row.migration_name));
    const missing = localMigrations(directory).filter((name) => !applied.has(name));
    if (missing.length) throw new Error(`Pending migrations: ${missing.join(', ')}`);

    const tables = await client.query(
      'SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = $1 AND tablename = ANY($2::text[])',
      ['public', REQUIRED_TABLES],
    );
    const found = new Set(tables.rows.map((row) => row.tablename));
    const missingTables = REQUIRED_TABLES.filter((name) => !found.has(name));
    if (missingTables.length) throw new Error(`Required tables are missing: ${missingTables.join(', ')}`);

    return {
      event: 'database_validation_passed',
      host: target.host,
      database: target.database,
      serverVersion: version.rows[0]?.server_version,
      migrations: applied.size,
      requiredTables: REQUIRED_TABLES.length,
    };
  } finally {
    await client.end().catch(() => {});
  }
};

const run = async () => {
  try {
    const result = await validateDatabase({ connectionString: process.env.DATABASE_URL });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(JSON.stringify({ event: 'database_validation_failed', error: error.message }));
    process.exitCode = 1;
  }
};

if (require.main === module) run();

module.exports = { validateConnectionPolicy, validateDatabase, localMigrations, REQUIRED_TABLES };
