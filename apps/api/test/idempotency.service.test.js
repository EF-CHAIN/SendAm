const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
const { validateKey, fingerprintRequest, createIdempotencyService, IdempotencyError } = require('../src/payment/idempotency.service');

const matchesWhere = (row, where) => Object.entries(where || {}).every(([field, expected]) => {
  if (expected && typeof expected === 'object' && 'lte' in expected) {
    return new Date(row[field]).getTime() <= new Date(expected.lte).getTime();
  }
  return row[field] === expected;
});

const makeDb = () => {
  const records = new Map();
  const transactions = new Map();
  let creates = 0;
  const composite = (userId, key) => `${userId}:wallet.send:${key}`;
  const api = {
    records,
    transactions,
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
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const row of records.values()) {
          if (matchesWhere(row, where)) {
            Object.assign(row, data);
            count += 1;
          }
        }
        return { count };
      },
    },
    transaction: {
      findUnique: async ({ where }) => transactions.get(where.id) || null,
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const row of transactions.values()) {
          if (matchesWhere(row, where)) {
            Object.assign(row, data);
            count += 1;
          }
        }
        return { count };
      },
    },
    // Runs the callback with this client, like Prisma's interactive transaction.
    $transaction: async (fn) => fn(api),
  };
  return api;
};

const seedProcessingRecord = (db, { leaseExpiresAt }) => {
  const row = {
    id: 'i-seed',
    userId: 'u1',
    operation: 'wallet.send',
    key: 'checkout-123',
    fingerprint: 'fp',
    state: 'processing',
    response: null,
    transaction: null,
    reservedTransactionId: 'tx-reserved',
    leaseExpiresAt,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  };
  db.records.set('u1:wallet.send:checkout-123', row);
  return row;
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

test('expired lease is not claimed when a transaction already exists for the reserved id', async () => {
  const db = makeDb();
  seedProcessingRecord(db, { leaseExpiresAt: new Date(Date.now() - 1000) });
  // First read sees no transaction, so replayOrWait returns null and the
  // claim runs; by then the transaction exists, so the claim must refuse.
  let transactionReads = 0;
  db.transaction.findUnique = async ({ where }) => {
    transactionReads += 1;
    if (transactionReads === 1) return null;
    return { id: where.id, status: 'failed' };
  };
  const service = createIdempotencyService(db, { wait: () => new Promise((resolve) => setImmediate(resolve)) });
  let runs = 0;
  await assert.rejects(
    service.execute({ userId: 'u1', key: 'checkout-123', fingerprint: 'fp', run: async () => { runs += 1; return { transactionId: 't1' }; } }),
    (error) => error instanceof IdempotencyError && error.statusCode === 409
  );
  assert.equal(runs, 0);
});

test('a stale owner cannot overwrite a row settled by another execution', async () => {
  const db = makeDb();
  const service = createIdempotencyService(db);
  const winnerResponse = { transactionId: 't-winner', status: 'success' };
  const result = await service.execute({
    userId: 'u1',
    key: 'checkout-123',
    fingerprint: 'fp',
    run: async () => {
      const row = db.records.get('u1:wallet.send:checkout-123');
      row.state = 'completed';
      row.response = winnerResponse;
      return { transactionId: 't-loser', status: 'success' };
    },
  });
  assert.equal(result.replayed, true);
  assert.deepEqual(result.response, winnerResponse);
  assert.deepEqual(db.records.get('u1:wallet.send:checkout-123').response, winnerResponse);
});

test('a failed run does not overwrite a row settled by another execution', async () => {
  const db = makeDb();
  const service = createIdempotencyService(db);
  const winnerResponse = { transactionId: 't-winner', status: 'success' };
  await assert.rejects(
    service.execute({
      userId: 'u1',
      key: 'checkout-123',
      fingerprint: 'fp',
      run: async () => {
        const row = db.records.get('u1:wallet.send:checkout-123');
        row.state = 'completed';
        row.response = winnerResponse;
        throw new Error('downstream broke');
      },
    }),
    (error) => error.message === 'downstream broke'
  );
  assert.deepEqual(db.records.get('u1:wallet.send:checkout-123').response, winnerResponse);
});

test('completion stores the Stellar hash when the transaction row lacks it', async () => {
  const db = makeDb();
  db.transactions.set('t1', { id: 't1', status: 'success', txHash: null });
  const service = createIdempotencyService(db);
  const result = await service.execute({
    userId: 'u1',
    key: 'checkout-123',
    fingerprint: 'fp',
    run: async () => ({ transaction: { id: 't1', txHash: 'hash-abc', status: 'success' } }),
  });
  assert.equal(result.replayed, false);
  assert.equal(db.transactions.get('t1').txHash, 'hash-abc');
  assert.equal(db.records.get('u1:wallet.send:checkout-123').transactionId, 't1');
});

test('completion never overwrites a transaction hash that is already stored', async () => {
  const db = makeDb();
  db.transactions.set('t1', { id: 't1', status: 'success', txHash: 'hash-old' });
  const service = createIdempotencyService(db);
  await service.execute({
    userId: 'u1',
    key: 'checkout-123',
    fingerprint: 'fp',
    run: async () => ({ transaction: { id: 't1', txHash: 'hash-new', status: 'success' } }),
  });
  assert.equal(db.transactions.get('t1').txHash, 'hash-old');
});

test('lease recovery takes a row-level lock when the client supports it', async () => {
  const db = makeDb();
  seedProcessingRecord(db, { leaseExpiresAt: new Date(Date.now() - 1000) });
  const issuedQueries = [];
  db.$queryRaw = async (strings, ...values) => {
    issuedQueries.push(strings.join('?'));
    const [userId, operation, key] = values;
    const row = db.records.get(`${userId}:${operation}:${key}`);
    return row ? [row] : [];
  };
  const service = createIdempotencyService(db, { wait: () => new Promise((resolve) => setImmediate(resolve)) });
  let runs = 0;
  const result = await service.execute({
    userId: 'u1',
    key: 'checkout-123',
    fingerprint: 'fp',
    run: async () => { runs += 1; return { transactionId: 't1' }; },
  });
  assert.equal(runs, 1);
  assert.equal(result.replayed, false);
  assert.equal(issuedQueries.some((query) => query.includes('FOR UPDATE')), true);
});
