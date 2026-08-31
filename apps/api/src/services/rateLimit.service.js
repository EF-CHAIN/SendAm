const crypto = require('crypto');
const prisma = require('../common/prisma');

/**
 * Fixed windows use PostgreSQL time exclusively. A window is active while
 * resetAt > CURRENT_TIMESTAMP; at resetAt (inclusive) the next hit starts a
 * new window. The single UPSERT is the serialization point across replicas.
 */
const consume = async (key, windowMs) => {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO "RateLimitHit" ("id", "key", "count", "resetAt", "createdAt", "updatedAt")
     VALUES ($1, $2, 1, CURRENT_TIMESTAMP + ($3 * INTERVAL '1 millisecond'), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT ("key") DO UPDATE SET
       "count" = CASE
         WHEN "RateLimitHit"."resetAt" <= CURRENT_TIMESTAMP THEN 1
         ELSE "RateLimitHit"."count" + 1
       END,
       "resetAt" = CASE
         WHEN "RateLimitHit"."resetAt" <= CURRENT_TIMESTAMP
           THEN CURRENT_TIMESTAMP + ($3 * INTERVAL '1 millisecond')
         ELSE "RateLimitHit"."resetAt"
       END,
       "updatedAt" = CURRENT_TIMESTAMP
     RETURNING "count", "resetAt"`,
    crypto.randomUUID(),
    key,
    windowMs
  );

  return { totalHits: rows[0].count, resetTime: rows[0].resetAt };
};

// Atomic and saturating: concurrent decrements can never make count negative.
const decrement = async (key) => {
  await prisma.$executeRawUnsafe(
    `UPDATE "RateLimitHit"
       SET "count" = GREATEST("count" - 1, 0), "updatedAt" = CURRENT_TIMESTAMP
     WHERE "key" = $1 AND "resetAt" > CURRENT_TIMESTAMP AND "count" > 0`,
    key
  );
};

const resetKey = async (key) => {
  await prisma.$executeRawUnsafe('DELETE FROM "RateLimitHit" WHERE "key" = $1', key);
};

module.exports = {
  consume,
  decrement,
  resetKey,
};
