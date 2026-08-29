const { Client } = require('pg');
const { validateDatabase } = require('./validate-production-db');

const DEFAULT_MAX_BACKUP_AGE_MINUTES = 24 * 60;
const DEFAULT_RTO_OBJECTIVE_MINUTES = 60;
const DEFAULT_QUEUE_MAX_AGE_MINUTES = 30;
const REPRESENTATIVE_TABLES = ['User', 'Wallet', 'Transaction'];

const parseTimestamp = (value, name) => {
  if (!value) throw new Error(`${name} is required`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${name} must be an ISO-8601 timestamp`);
  return date;
};

const minutesBetween = (later, earlier) => Math.max(0, Math.round((later.getTime() - earlier.getTime()) / 60000));

const parsePositiveInteger = (value, fallback, name) => {
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
};

const fs = require('fs');

const readBackupMetadata = (env) => {
  if (env.BACKUP_METADATA_JSON) {
    const metadata = JSON.parse(env.BACKUP_METADATA_JSON);
    return {
      completedAt: metadata.completedAt || metadata.completed_at,
      backupId: metadata.backupId || metadata.backup_id || 'metadata-json',
    };
  }
  const filePath = env.BACKUP_METADATA_FILE || '/var/backups/latest-backup.json';
  if (fs.existsSync(filePath)) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const metadata = JSON.parse(content);
      return {
        completedAt: metadata.completedAt || metadata.completed_at,
        backupId: metadata.backupId || metadata.backup_id || filePath,
      };
    } catch (_err) {
      // Ignore file parse error and fall back to env vars
    }
  }
  return {
    completedAt: env.LATEST_BACKUP_COMPLETED_AT,
    backupId: env.LATEST_BACKUP_ID || 'latest',
  };
};

const validateBackupFreshness = ({ completedAt, now, maxAgeMinutes }) => {
  const backupCompletedAt = parseTimestamp(completedAt, 'latest backup completion time');
  const rpoMinutes = minutesBetween(now, backupCompletedAt);
  if (backupCompletedAt.getTime() > now.getTime()) throw new Error('latest backup completion time cannot be in the future');
  if (rpoMinutes > maxAgeMinutes) {
    throw new Error(`Latest backup is stale: ${rpoMinutes} minutes old exceeds ${maxAgeMinutes} minute RPO`);
  }
  return { backupCompletedAt: backupCompletedAt.toISOString(), rpoMinutes };
};

const validateRedisQueue = async ({ redisUrl, maxAgeMinutes, redisFactory }) => {
  if (!redisUrl) return { checked: false, reason: 'REDIS_URL was not provided' };
  const Redis = redisFactory || require('ioredis');
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, enableReadyCheck: true });
  try {
    const queueNames = ['whatsapp'];
    const waitingCounts = await Promise.all(queueNames.map((name) => redis.llen(`bull:${name}:wait`)));
    const delayedCounts = await Promise.all(queueNames.map((name) => redis.zcard(`bull:${name}:delayed`)));
    const failedCounts = await Promise.all(queueNames.map((name) => redis.zcard(`bull:${name}:failed`)));
    return {
      checked: true,
      maxQueueAgeMinutes: maxAgeMinutes,
      waitingJobs: waitingCounts.reduce((sum, count) => sum + Number(count || 0), 0),
      delayedJobs: delayedCounts.reduce((sum, count) => sum + Number(count || 0), 0),
      failedJobs: failedCounts.reduce((sum, count) => sum + Number(count || 0), 0),
    };
  } finally {
    if (typeof redis.quit === 'function') await redis.quit().catch(() => redis.disconnect?.());
    else redis.disconnect?.();
  }
};

const queryRepresentativeCounts = async (client) => {
  const counts = {};
  for (const table of REPRESENTATIVE_TABLES) {
    const result = await client.query(`SELECT count(*)::int AS count FROM "${table}"`);
    counts[table] = result.rows[0]?.count || 0;
  }
  return counts;
};

const verifyWalletDecryptability = async (client, decrypt) => {
  const result = await client.query('SELECT id, "encryptedSecretKey" FROM "Wallet" WHERE "encryptedSecretKey" IS NOT NULL LIMIT 5');
  let checked = 0;
  for (const row of result.rows) {
    decrypt(row.encryptedSecretKey);
    checked += 1;
  }
  return { checked, sampleSize: result.rows.length };
};

const runRestoreDrill = async ({
  env = process.env,
  now,
  drillStartTime,
  clientFactory = (config) => new Client(config),
  redisFactory,
  decrypt,
} = {}) => {
  const startedAt = now
    || (drillStartTime ? new Date(drillStartTime) : null)
    || (env.RESTORE_DRILL_START_TIME || env.DRILL_START_TIME ? new Date(env.RESTORE_DRILL_START_TIME || env.DRILL_START_TIME) : new Date());
  const connectionString = env.DATABASE_URL || env.DRILL_DATABASE_URL;
  if (!connectionString) throw new Error('DRILL_DATABASE_URL or DATABASE_URL is required');

  const maxAgeMinutes = parsePositiveInteger(env.RESTORE_DRILL_MAX_BACKUP_AGE_MINUTES, DEFAULT_MAX_BACKUP_AGE_MINUTES, 'RESTORE_DRILL_MAX_BACKUP_AGE_MINUTES');
  const rtoObjectiveMinutes = parsePositiveInteger(env.RESTORE_DRILL_RTO_OBJECTIVE_MINUTES, DEFAULT_RTO_OBJECTIVE_MINUTES, 'RESTORE_DRILL_RTO_OBJECTIVE_MINUTES');
  const queueMaxAgeMinutes = parsePositiveInteger(env.RESTORE_DRILL_QUEUE_MAX_AGE_MINUTES, DEFAULT_QUEUE_MAX_AGE_MINUTES, 'RESTORE_DRILL_QUEUE_MAX_AGE_MINUTES');
  const metadata = readBackupMetadata(env);
  const freshness = validateBackupFreshness({ completedAt: metadata.completedAt, now: startedAt, maxAgeMinutes });

  const schema = await validateDatabase({ connectionString, nodeEnv: env.NODE_ENV || 'production', clientFactory });
  const client = clientFactory({ connectionString, connectionTimeoutMillis: 10000 });
  try {
    await client.connect();
    const counts = await queryRepresentativeCounts(client);
    const walletDecrypt = await verifyWalletDecryptability(client, decrypt || require('../src/services/crypto.service').decrypt);
    const queue = await validateRedisQueue({ redisUrl: env.REDIS_URL || env.UPSTASH_REDIS_URL, maxAgeMinutes: queueMaxAgeMinutes, redisFactory });
    const finishedAt = now || new Date();
    const rtoMinutes = Math.max(1, minutesBetween(finishedAt, startedAt));
    if (rtoMinutes > rtoObjectiveMinutes) throw new Error(`Restore drill RTO ${rtoMinutes} minutes exceeds ${rtoObjectiveMinutes} minute objective`);
    return {
      event: 'restore_drill_passed',
      backupId: metadata.backupId,
      backupCompletedAt: freshness.backupCompletedAt,
      rpoMinutes: freshness.rpoMinutes,
      rtoMinutes,
      rtoObjectiveMinutes,
      schema,
      representativeCounts: counts,
      walletDecrypt,
      queue,
      evidenceRedacted: true,
    };
  } finally {
    await client.end().catch(() => {});
  }
};

const run = async () => {
  try {
    const result = await runRestoreDrill();
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(JSON.stringify({ event: 'restore_drill_failed', error: error.message }));
    process.exitCode = 1;
  }
};

if (require.main === module) run();

module.exports = {
  runRestoreDrill,
  validateBackupFreshness,
  readBackupMetadata,
  validateRedisQueue,
  DEFAULT_MAX_BACKUP_AGE_MINUTES,
};
