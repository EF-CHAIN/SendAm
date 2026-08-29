const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const injectMock = (relativeFromSrc, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relativeFromSrc}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

const mockTransaction = {
  id: 'tx_abc123',
  txHash: 'stellar_hash_xyz',
  asset: 'XLM',
  amount: '50.0000000',
  status: 'success',
  createdAt: new Date('2026-08-26T12:00:00.000Z'),
  recipientPhoneNumber: '+2348012345678',
  destination: 'GABC123recipient',
  quoteId: 'quote_123',
  metadata: { fee: '0.5000000' },
  user: {
    phoneNumber: '+2348033334444',
  },
};

const prismaMock = {
  transaction: {
    findUnique: async ({ where }) => {
      if (where.id === 'tx_abc123') {
        return mockTransaction;
      }
      return null;
    },
  },
};

injectMock('common/prisma', prismaMock);

const { verifyReceipt } = require('../src/controllers/receipt.controller');

test('verifyReceipt resolves existing receipt with privacy-safe masking', async () => {
  const req = {
    params: { id: 'SDA-tx_abc123' },
  };

  let responseData = null;
  let responseStatus = null;

  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      responseStatus = this.statusCode;
      responseData = data;
      return this;
    },
  };

  await verifyReceipt(req, res, (err) => {
    if (err) assert.fail(err);
  });

  assert.equal(responseStatus, 200);
  assert.ok(responseData.success);
  assert.equal(responseData.data.receipt.receiptId, 'SDA-tx_abc123');
  assert.equal(responseData.data.receipt.transactionHash, 'stellar_hash_xyz');
  assert.equal(responseData.data.receipt.amount, '50.0000000');
  assert.equal(responseData.data.receipt.fee, '0.5000000');
  
  // Verify parties are masked correctly
  assert.equal(responseData.data.receipt.parties.sender, '+234******4444');
  assert.equal(responseData.data.receipt.parties.recipient, '+234******5678');
});

test('verifyReceipt returns 404 for unknown receipt', async () => {
  const req = {
    params: { id: 'SDA-unknown' },
  };

  let responseData = null;
  let responseStatus = null;

  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      responseStatus = this.statusCode;
      responseData = data;
      return this;
    },
  };

  await verifyReceipt(req, res, (err) => {
    if (err) assert.fail(err);
  });

  assert.equal(responseStatus, 404);
  assert.equal(responseData.success, false);
});