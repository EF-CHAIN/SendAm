const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';

const prisma = require('../src/common/prisma');
const calls = [];
prisma.$queryRawUnsafe = async (...args) => {
  calls.push(['query', ...args]);
  return [{ count: 7, resetAt: new Date('2030-01-01T00:00:00Z') }];
};
prisma.$executeRawUnsafe = async (...args) => calls.push(['execute', ...args]);

const service = require('../src/services/rateLimit.service');

beforeEach(() => calls.splice(0));

test('consume uses one atomic upsert and database time', async () => {
  const result = await service.consume('api:client', 60_000);
  assert.equal(result.totalHits, 7);
  assert.match(calls[0][1], /INSERT INTO "RateLimitHit"/);
  assert.match(calls[0][1], /ON CONFLICT \("key"\) DO UPDATE/);
  assert.match(calls[0][1], /"resetAt" <= CURRENT_TIMESTAMP/);
  assert.equal(calls[0][3], 'api:client');
  assert.equal(calls[0][4], 60_000);
});

test('decrement is atomic, active-window-only, and saturates at zero', async () => {
  await service.decrement('bot:sender');
  assert.match(calls[0][1], /GREATEST\("count" - 1, 0\)/);
  assert.match(calls[0][1], /"resetAt" > CURRENT_TIMESTAMP/);
  assert.equal(calls[0][2], 'bot:sender');
});

test('reset deletes exactly the requested key', async () => {
  await service.resetKey('api:client');
  assert.match(calls[0][1], /^DELETE FROM/);
  assert.equal(calls[0][2], 'api:client');
});
