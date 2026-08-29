const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');
const config = require('../config/env');
const { increment, observeDuration, setGauge } = require('../observability/metrics');

const dbUrl = config.databaseUrl || process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/sendam_dev';

if (!dbUrl) {
  throw new Error('DATABASE_URL must be set. Use your Neon PostgreSQL connection string.');
}

const pool = new Pool({
  connectionString: dbUrl,
  ssl: config.databaseCa ? { ca: config.databaseCa, rejectUnauthorized: true } : undefined,
  max: config.databasePool.max,
  connectionTimeoutMillis: config.databasePool.connectionTimeoutMs,
  idleTimeoutMillis: config.databasePool.poolTimeoutMs,
});
pool.on('error', (error) => increment('sendam_database_pool_errors_total', { message: error.message }));
pool.on('acquire', () => setGauge('sendam_database_pool_waiting', pool.waitingCount));
const connectFromPool = pool.connect.bind(pool);
pool.connect = (...args) => {
  const started = process.hrtime.bigint();
  let expired = false;
  const connection = connectFromPool(...args);
  connection.then((client) => {
    if (expired) client.release();
  }).catch(() => {});
  let timeoutHandle;
  const timeout = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      expired = true;
      increment('sendam_database_pool_timeouts_total');
      reject(new Error('Database pool wait timed out'));
    }, config.databasePool.poolTimeoutMs);
  });
  return Promise.race([connection, timeout]).finally(() => {
    clearTimeout(timeoutHandle);
    observeDuration(
      'sendam_database_pool_wait_seconds',
      {},
      Number(process.hrtime.bigint() - started) / 1e9,
    );
  });
};

const adapter = new PrismaPg(pool, { disposeExternalPool: true });

const updatePoolMetrics = () => {
  setGauge('sendam_database_pool_total', pool.totalCount);
  setGauge('sendam_database_pool_idle', pool.idleCount);
  setGauge('sendam_database_pool_waiting', pool.waitingCount);
};
setInterval(updatePoolMetrics, 1000).unref();

const prisma = new PrismaClient({ adapter });

module.exports = prisma;
