const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/db';

const { processMessage } = require('../src/whatsapp/assistant.service');

const VALID_STELLAR_ADDR = 'GCFUBXHMSAG6SQ64VDW24EATZ6VSCCDGAN57X2HGBUXLUUPUC4XR5S6Z';

test('resumable payment state structure and TTL expiration with in-memory mock', async () => {
  const phone = '+2348000999888';
  let userState = {
    id: 'u_resumable_1',
    phoneNumber: phone,
    whatsappName: 'Alice',
    pendingSend: null,
    locale: 'en',
  };

  const fakeDb = {
    user: {
      findUnique: async () => userState,
      create: async ({ data }) => {
        userState = { id: 'u_resumable_1', ...data };
        return userState;
      },
      update: async ({ data }) => {
        Object.assign(userState, data);
        return userState;
      },
    },
    transaction: { findFirst: async () => null, findMany: async () => [] },
    alias: { findFirst: async () => null, findUnique: async () => null },
  };

  const replies = [];
  const notify = async (to, text) => {
    replies.push(text);
  };

  // Step 1: Initiate payment to new address (high-risk step)
  await processMessage(phone, 'Alice', `send 25 USDC to ${VALID_STELLAR_ADDR}`, {
    notify,
    prisma: fakeDb,
  });

  assert.equal(replies.length, 1);
  assert.equal(replies[0].includes('HIGH-RISK RECIPIENT DETECTED'), true);
  assert.equal(userState.pendingSend.step, 'AWAITING_HIGH_RISK_CONFIRMATION');
  assert.equal(typeof userState.pendingSend.stateId, 'string');
  assert.equal(typeof userState.pendingSend.expiresAt, 'string');

  // SIMULATE WORKER RESTART: send YES to confirm recipient
  replies.length = 0;
  await processMessage(phone, 'Alice', 'YES', {
    notify,
    prisma: fakeDb,
  });

  assert.equal(replies.length, 1);
  assert.equal(replies[0].includes('Please confirm this payment'), true);
  assert.equal(userState.pendingSend.step, 'AWAITING_PIN');
  assert.equal(userState.pendingSend.highRiskConfirmed, true);

  // SIMULATE WORKER RESTART: user cancels payment
  replies.length = 0;
  await processMessage(phone, 'Alice', 'cancel', {
    notify,
    prisma: fakeDb,
  });

  assert.equal(replies.length, 1);
  assert.equal(replies[0].includes('cancelled'), true);
  assert.ok(!userState.pendingSend || typeof userState.pendingSend === 'symbol' || Object.keys(userState.pendingSend).length === 0);
});

test('expired resumable state is rejected and cleared with in-memory mock', async () => {
  const phone = '+2348000999777';
  let userState = {
    id: 'u_expired_1',
    phoneNumber: phone,
    whatsappName: 'Bob',
    pendingSend: {
      version: 1,
      stateId: 'ps_expired_123',
      step: 'AWAITING_PIN',
      amount: '50',
      asset: 'XLM',
      destination: VALID_STELLAR_ADDR,
      alias: 'Bob',
      requestedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      expiresAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    },
    locale: 'en',
  };

  const fakeDb = {
    user: {
      findUnique: async () => userState,
      update: async ({ data }) => {
        Object.assign(userState, data);
        return userState;
      },
    },
  };

  const replies = [];
  const notify = async (to, text) => {
    replies.push(text);
  };

  // Attempt to submit PIN after expiry
  await processMessage(phone, 'Bob', '1234', {
    notify,
    prisma: fakeDb,
  });

  assert.equal(replies.length, 1);
  assert.equal(replies[0].includes('expired'), true);
  assert.ok(!userState.pendingSend || typeof userState.pendingSend === 'symbol' || Object.keys(userState.pendingSend).length === 0);
});

if (process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('postgresql://user:pass')) {
  const prisma = require('../src/common/prisma');

  test('resumable payment flow with PostgreSQL connection', async () => {
    const phone = '+2348000999888';
    const replies = [];
    const notify = async (to, text) => replies.push(text);

    await prisma.user.deleteMany({ where: { phoneNumber: phone } });

    await processMessage(phone, 'Alice', `send 25 USDC to ${VALID_STELLAR_ADDR}`, { notify });
    assert.equal(replies.length, 1);

    const user = await prisma.user.findUnique({ where: { phoneNumber: phone } });
    assert.equal(user.pendingSend.step, 'AWAITING_HIGH_RISK_CONFIRMATION');

    await prisma.user.deleteMany({ where: { phoneNumber: phone } });
  });
}
