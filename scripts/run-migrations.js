const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const { Client } = require('pg');

const workspace = path.resolve(__dirname, '../apps/api');
require('dotenv').config({ path: path.join(workspace, '.env') });

const migrationLock = 1022001;

async function run() {
  const databaseUrl = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Set DATABASE_URL or MIGRATION_DATABASE_URL to a direct PostgreSQL connection');

  const prismaPackage = require.resolve('prisma/package.json', { paths: [workspace] });
  const prismaCli = path.resolve(path.dirname(prismaPackage), require(prismaPackage).bin.prisma);
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10000, keepAlive: true });
  let child;
  let interrupted;
  const stop = (error) => {
    interrupted ??= error;
    if (child) child.kill();
    else void client.end().catch(() => {});
  };
  const onSignal = (signal) => stop(new Error(`Migration interrupted by ${signal}`));
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  client.on('error', stop);

  try {
    await client.connect();
    await client.query('SELECT pg_advisory_lock($1::bigint)', [migrationLock]);
    if (interrupted) throw interrupted;

    child = spawn(process.execPath, [prismaCli, 'migrate', 'deploy'], {
      cwd: workspace,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'inherit',
    });
    const [code, signal] = await once(child, 'close');
    if (interrupted) throw interrupted;
    if (code !== 0) throw new Error(`Prisma migration exited with ${signal || `code ${code}`}`);
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    // Closing this dedicated session releases its advisory lock on every exit path.
    await client.end();
  }
}

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
