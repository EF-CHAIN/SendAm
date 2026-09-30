const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const express = require('express');

// Route-level coverage for receipt.routes.js (#434). The router and the real
// receipt controller are mounted over HTTP; only Prisma is stubbed so the test
// stays offline.
const inject = (relative, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relative}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

const storedTransaction = {
  id: 'cktx123abc',
  txHash: 'stellar_hash_xyz',
  asset: 'XLM',
  amount: '25.0000000',
  status: 'success',
  createdAt: new Date('2026-09-01T10:00:00.000Z'),
  recipientPhoneNumber: '+2348012345678',
  metadata: { fee: '0.0000100' },
  user: { phoneNumber: '+2348033334444' },
};

const lookups = [];
inject('common/prisma', {
  transaction: {
    findUnique: async ({ where }) => {
      lookups.push(where.id);
      return where.id === storedTransaction.id ? storedTransaction : null;
    },
  },
});

const receiptRoutes = require('../src/routes/receipt.routes');
const errorHandler = require('../src/middlewares/errorHandler');

const buildApp = () => {
  const app = express();
  app.use('/api/receipts', receiptRoutes);
  app.use(errorHandler);
  return app;
};

const withServer = async (run) => {
  const server = http.createServer(buildApp());
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

beforeEach(() => { lookups.length = 0; });

test('GET /api/receipts/:id returns the masked receipt for an existing transaction', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/receipts/${storedTransaction.id}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.receipt.receiptId, 'SDA-cktx123abc');
    assert.equal(body.data.receipt.transactionId, 'cktx123abc');
    assert.equal(body.data.receipt.parties.sender, '+234******4444');
    assert.equal(body.data.receipt.parties.recipient, '+234******5678');
  });
  assert.deepEqual(lookups, ['cktx123abc']);
});

test('GET /api/receipts/:id/verify accepts the public SDA- prefixed receipt id', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/receipts/SDA-${storedTransaction.id}/verify`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.receipt.receiptId, 'SDA-cktx123abc');
  });
  assert.deepEqual(lookups, ['cktx123abc'], 'SDA- prefix is stripped before the lookup');
});

test('GET /api/receipts/:id returns 404 when no transaction matches', async () => {
  await withServer(async (base) => {
    for (const url of ['/api/receipts/ckmissing999', '/api/receipts/SDA-ckmissing999/verify']) {
      const res = await fetch(`${base}${url}`);
      assert.equal(res.status, 404, url);
      const body = await res.json();
      assert.equal(body.success, false);
      assert.equal(body.message, 'Receipt not found');
    }
  });
  assert.deepEqual(lookups, ['ckmissing999', 'ckmissing999']);
});

test('GET /api/receipts/:id rejects malformed ids with 400 before touching the database', async () => {
  const invalidIds = [
    encodeURIComponent('tx 123'),
    encodeURIComponent("tx';DROP TABLE"),
    encodeURIComponent('../../etc/passwd'),
    'a'.repeat(65),
  ];
  await withServer(async (base) => {
    for (const id of invalidIds) {
      for (const suffix of ['', '/verify']) {
        const res = await fetch(`${base}/api/receipts/${id}${suffix}`);
        assert.equal(res.status, 400, `${id}${suffix}`);
        const body = await res.json();
        assert.equal(body.success, false);
        assert.equal(body.error.code, 'validation_error');
      }
    }
  });
  assert.deepEqual(lookups, [], 'invalid ids never reach Prisma');
});
