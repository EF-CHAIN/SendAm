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

const PostgresRateStore = require('../src/middlewares/postgresRateStore');

beforeEach(() => calls.splice(0));

test('constructor sets prefix', () => {
  const store = new PostgresRateStore('custom:');
  assert.equal(store.prefix, 'custom:');
});

test('init stores windowMs', () => {
  const store = new PostgresRateStore();
  store.init({ windowMs: 120_000 });
  assert.equal(store.windowMs, 120_000);
});

test('increment prefixes key and calls consume with windowMs', async () => {
  const store = new PostgresRateStore('api:');
  store.init({ windowMs: 60_000 });

  const result = await store.increment('client:123');

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'query');
  assert.match(calls[0][1], /INSERT INTO "RateLimitHit"/);
  assert.match(calls[0][1], /ON CONFLICT \("key"\) DO UPDATE/);
  assert.equal(calls[0][3], 'api:client:123');
  assert.equal(calls[0][4], 60_000);
  assert.equal(result.totalHits, 7);
});

test('decrement prefixes key and calls decrement service', async () => {
  const store = new PostgresRateStore('bot:');
  store.init({ windowMs: 60_000 });

  await store.decrement('sender:456');

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'execute');
  assert.match(calls[0][1], /GREATEST\("count" - 1, 0\)/);
  assert.match(calls[0][1], /"resetAt" > CURRENT_TIMESTAMP/);
  assert.equal(calls[0][2], 'bot:sender:456');
});

test('resetKey prefixes key and calls resetKey service', async () => {
  const store = new PostgresRateStore('api:');
  store.init({ windowMs: 60_000 });

  await store.resetKey('client:123');

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'execute');
  assert.match(calls[0][1], /^DELETE FROM/);
  assert.equal(calls[0][2], 'api:client:123');
});

test('increment uses default empty prefix when none provided', async () => {
  const store = new PostgresRateStore();
  store.init({ windowMs: 60_000 });

  await store.increment('raw-key');

  assert.equal(calls[0][3], 'raw-key');
});

test('decrement uses default empty prefix when none provided', async () => {
  const store = new PostgresRateStore();
  store.init({ windowMs: 60_000 });

  await store.decrement('raw-key');

  assert.equal(calls[0][2], 'raw-key');
});

test('resetKey uses default empty prefix when none provided', async () => {
  const store = new PostgresRateStore();
  store.init({ windowMs: 60_000 });

  await store.resetKey('raw-key');

  assert.equal(calls[0][2], 'raw-key');
});