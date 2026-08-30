const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
const { validateKey, fingerprintRequest, createIdempotencyService, IdempotencyError } = require('../src/payment/idempotency.service');

const makeDb = () => {
  const records = new Map();
  let creates = 0;
  const composite = (userId, key) => `${userId}:wallet.send:${key}`;
  return {
    records,
    get creates() { return creates; },
    paymentIdempotency: {
      create: async ({ data }) => {
        const mapKey = composite(data.userId, data.key);
        if (records.has(mapKey)) throw Object.assign(new Error('unique'), { code: 'P2002' });
        creates += 1;
        const row = { id: `i${creates}`, state: 'processing', response: null, transaction: null, ...data };
        records.set(mapKey, row);
        return row;
      },
      findUnique: async ({ where }) => {
        const { userId, key } = where.userId_operation_key;
        return records.get(composite(userId, key)) || null;
      },
      update: async ({ where, data }) => {
        const row = [...records.values()].find((item) => item.id === where.id);
        Object.assign(row, data);
        return row;
      },
      updateMany: async () => ({ count: 0 }),
    },
  };
};

test('validates caller keys and canonicalizes material payment fields', () => {
  assert.equal(validateKey('checkout-123'), true);
  assert.equal(validateKey('short'), false);
  assert.equal(fingerprintRequest({ amount: 5, destination: ' GABC ', asset: 'xlm' }), fingerprintRequest({ amount: '5', destination: 'GABC', asset: 'XLM' }));
  assert.notEqual(fingerprintRequest({ amount: 5, destination: 'GABC' }), fingerprintRequest({ amount: 6, destination: 'GABC' }));
});

test('sequential retry replays one stored response and runs payment once', async () => {
  const db = makeDb();
  const service = createIdempotencyService(db);
  let runs = 0;
  const input = { userId: 'u1', key: 'checkout-123', fingerprint: 'fp', run: async () => { runs += 1; return { transactionId: 't1', status: 'success' }; } };
  const first = await service.execute(input);
  const second = await service.execute(input);
  assert.equal(runs, 1);
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.deepEqual(second.response, first.response);
});

test('same key with changed input is rejected', async () => {
  const db = makeDb();
  const service = createIdempotencyService(db);
  await service.execute({ userId: 'u1', key: 'checkout-123', fingerprint: 'fp1', run: async () => ({ ok: true }) });
  await assert.rejects(
    service.execute({ userId: 'u1', key: 'checkout-123', fingerprint: 'fp2', run: async () => ({ ok: false }) }),
    (error) => error instanceof IdempotencyError && error.statusCode === 409
  );
});

test('concurrent first requests wait for and replay the winning response', async () => {
  const db = makeDb();
  const service = createIdempotencyService(db, { wait: () => new Promise((resolve) => setImmediate(resolve)) });
  let runs = 0;
  const input = { userId: 'u1', key: 'checkout-123', fingerprint: 'fp', run: async () => { runs += 1; await new Promise((resolve) => setImmediate(resolve)); return { transactionId: 't1' }; } };
  const results = await Promise.all([service.execute(input), service.execute(input)]);
  assert.equal(runs, 1);
  assert.deepEqual(results.map((item) => item.replayed).sort(), [false, true]);
});
