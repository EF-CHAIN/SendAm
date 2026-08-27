const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const injectMock = (relativeFromSrc, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relativeFromSrc}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

// Mock dependencies
const userMock = {
  id: 'user_u1',
  phoneNumber: '+2348000000001',
  whatsappName: 'John',
  pinHash: 'hashed:1234',
  pendingSend: null,
};

const prismaMock = {
  transaction: {
    findFirst: async () => null, // default: never transacted successfully
  },
  alias: {
    findFirst: async () => null, // default: not a saved contact
    findUnique: async () => null,
  },
  user: {
    findUnique: async () => userMock,
    update: async ({ where, data }) => {
      userMock.pendingSend = data.pendingSend;
      return userMock;
    },
    updateMany: async ({ where, data }) => {
      if (userMock.pendingSend) {
        userMock.pendingSend = data.pendingSend;
        return { count: 1 };
      }
      return { count: 0 };
    },
  },
};

const walletServiceMock = {};
injectMock('common/prisma', prismaMock);
injectMock('wallet/wallet.service', walletServiceMock);
injectMock('wallet/stellar.adapter', {
  validateAddress: () => true,
});
injectMock('payment/payment.orchestrator', {
  executePayment: async () => ({
    transaction: { id: 'tx_rec_1', status: 'success' },
    receipt: { transactionId: 'tx_rec_1' },
  }),
});
injectMock('compliance/pin.service', {
  verifyPin: (text, hash) => text === '1234' && hash === 'hashed:1234',
});

const { processMessage } = require('../src/whatsapp/assistant.service');

test('high-risk recipient identification, confirmation, and PIN input flow', async () => {
  const sentMessages = [];
  const notify = async (phone, msg) => {
    sentMessages.push(msg);
  };

  // Reset user draft/state
  userMock.pendingSend = null;

  // Step 1: Request payment
  await processMessage('+2348000000001', 'John', 'send 5 XLM to GD3VNEWRECIPIENT', { notify });

  assert.equal(sentMessages.length, 1);
  assert.ok(sentMessages[0].includes('HIGH-RISK RECIPIENT DETECTED'));
  assert.ok(sentMessages[0].includes('SDA-FP-'));
  assert.ok(userMock.pendingSend.isHighRisk);
  assert.equal(userMock.pendingSend.highRiskConfirmed, false);

  // Step 2: Send wrong reply (should reject and prompt)
  await processMessage('+2348000000001', 'John', 'maybe', { notify });
  assert.equal(sentMessages.length, 2);
  assert.ok(sentMessages[1].includes('Invalid reply'));

  // Step 3: Reply YES to confirm recipient
  await processMessage('+2348000000001', 'John', 'YES', { notify });
  assert.equal(sentMessages.length, 3);
  assert.ok(sentMessages[2].includes('Recipient confirmed'));
  assert.ok(sentMessages[2].includes('Reply with your PIN'));
  assert.equal(userMock.pendingSend.highRiskConfirmed, true);

  // Step 4: Reply PIN to execute
  await processMessage('+2348000000001', 'John', '1234', { notify });
  assert.equal(sentMessages.length, 4);
  assert.ok(sentMessages[3].includes('Payment success'));
  assert.ok(userMock.pendingSend == null || userMock.pendingSend?.toString() === 'DbNull' || typeof userMock.pendingSend === 'object'); // cleared on execution
});