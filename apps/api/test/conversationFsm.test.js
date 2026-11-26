'use strict';

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/db';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const conversationFsm = require('../src/whatsapp/conversationFsm');
const {
  STATES,
  SESSION_TTL_SECONDS,
  saveSession,
  getSession,
  transition,
  resumeSession,
  getResumePrompt,
  handleFsmMessage,
  _resetMemoryStores,
} = conversationFsm;

const TEST_PHONE = '+2348011223344';

// A mock Redis client implementing get, set, del
const createMockRedis = () => {
  const store = new Map();
  const ttls = new Map();

  return {
    store,
    ttls,
    get: async (key) => store.get(key) || null,
    set: async (key, value, mode, ttl) => {
      store.set(key, value);
      if (mode === 'EX') ttls.set(key, ttl);
      return 'OK';
    },
    del: async (key) => {
      const existed = store.delete(key);
      ttls.delete(key);
      return existed ? 1 : 0;
    },
  };
};

beforeEach(() => {
  _resetMemoryStores();
});

test('FSM exports required states and 10-minute TTL', () => {
  assert.equal(STATES.IDLE, 'IDLE');
  assert.equal(STATES.AWAITING_AMOUNT, 'AWAITING_AMOUNT');
  assert.equal(STATES.AWAITING_CONFIRMATION, 'AWAITING_CONFIRMATION');
  assert.equal(STATES.AWAITING_PIN, 'AWAITING_PIN');
  assert.equal(SESSION_TTL_SECONDS, 600); // 10 minutes
});

test('persists session in Redis with 10-minute TTL (600s)', async () => {
  const mockRedis = createMockRedis();
  const context = { recipient: 'Ada', asset: 'XLM' };

  await saveSession(TEST_PHONE, {
    state: STATES.AWAITING_AMOUNT,
    context,
  }, { redis: mockRedis });

  const expectedKey = `whatsapp:fsm:session:${TEST_PHONE}`;
  assert.equal(mockRedis.store.has(expectedKey), true);
  assert.equal(mockRedis.ttls.get(expectedKey), 600);

  const raw = JSON.parse(mockRedis.store.get(expectedKey));
  assert.equal(raw.state, STATES.AWAITING_AMOUNT);
  assert.equal(raw.context.recipient, 'Ada');
  assert.equal(raw.context.asset, 'XLM');
  assert.ok(raw.expiresAt);
});

test('user state is preserved across server restarts via Redis', async () => {
  const mockRedis = createMockRedis();

  // Step 1: Server 1 stores session in Redis
  await saveSession(TEST_PHONE, {
    state: STATES.AWAITING_CONFIRMATION,
    context: { recipient: 'Chisom', amount: '100', asset: 'USDC' },
  }, { redis: mockRedis });

  // SIMULATE SERVER RESTART: In-memory memorySessionStore wiped
  _resetMemoryStores();

  // Server 2 reads from Redis
  const session = await getSession(TEST_PHONE, { redis: mockRedis });
  assert.equal(session.state, STATES.AWAITING_CONFIRMATION);
  assert.equal(session.context.recipient, 'Chisom');
  assert.equal(session.context.amount, '100');
  assert.equal(session.context.asset, 'USDC');
  assert.equal(session.expired, undefined);
});

test('validates FSM state transitions and rejects invalid jumps', async () => {
  const mockRedis = createMockRedis();

  // IDLE -> AWAITING_AMOUNT
  let session = await transition(
    TEST_PHONE,
    STATES.AWAITING_AMOUNT,
    { recipient: 'Kofi' },
    { redis: mockRedis }
  );
  assert.equal(session.state, STATES.AWAITING_AMOUNT);
  assert.equal(session.context.recipient, 'Kofi');

  // AWAITING_AMOUNT -> AWAITING_CONFIRMATION
  session = await transition(
    TEST_PHONE,
    STATES.AWAITING_CONFIRMATION,
    { amount: '50', asset: 'XLM' },
    { redis: mockRedis }
  );
  assert.equal(session.state, STATES.AWAITING_CONFIRMATION);
  assert.equal(session.context.recipient, 'Kofi');
  assert.equal(session.context.amount, '50');

  // AWAITING_CONFIRMATION -> AWAITING_PIN
  session = await transition(
    TEST_PHONE,
    STATES.AWAITING_PIN,
    { confirmedAt: new Date().toISOString() },
    { redis: mockRedis }
  );
  assert.equal(session.state, STATES.AWAITING_PIN);

  // AWAITING_PIN -> IDLE
  session = await transition(
    TEST_PHONE,
    STATES.IDLE,
    {},
    { redis: mockRedis }
  );
  assert.equal(session.state, STATES.IDLE);

  // Invalid jump: IDLE -> AWAITING_PIN directly should throw
  await assert.rejects(
    async () => {
      await transition(TEST_PHONE, STATES.AWAITING_PIN, {}, { redis: mockRedis });
    },
    /Invalid FSM transition/
  );
});

test('session expires cleanly after inactivity with informative resume prompt', async () => {
  const mockRedis = createMockRedis();
  const past = Date.now() - 15 * 60 * 1000; // 15 minutes ago
  const expiredAt = new Date(past + 10 * 60 * 1000).toISOString(); // Expired 5 mins ago

  // Save an expired session in Redis
  const sessionData = {
    phoneNumber: TEST_PHONE,
    state: STATES.AWAITING_PIN,
    context: { recipient: 'Kwame', amount: '75', asset: 'USDC' },
    updatedAt: new Date(past).toISOString(),
    expiresAt: expiredAt,
  };
  await mockRedis.set(
    `whatsapp:fsm:session:${TEST_PHONE}`,
    JSON.stringify(sessionData),
    'EX',
    600
  );

  // Get session: should detect expiration, clear active session, and archive expired context
  const session = await getSession(TEST_PHONE, { redis: mockRedis });
  assert.equal(session.expired, true);
  assert.equal(session.state, STATES.IDLE);
  assert.equal(session.previousSession.context.recipient, 'Kwame');
  assert.equal(session.previousSession.context.amount, '75');

  // Check resume prompt formatting
  const promptEn = getResumePrompt(session.previousSession, 'en');
  assert.ok(promptEn.includes('75 USDC'));
  assert.ok(promptEn.includes('Kwame'));
  assert.ok(promptEn.includes('timed out due to inactivity'));
  assert.ok(promptEn.includes('Reply YES to resume'));

  // Test resume action
  const resumed = await resumeSession(TEST_PHONE, { redis: mockRedis });
  assert.ok(resumed);
  assert.equal(resumed.state, STATES.AWAITING_PIN);
  assert.equal(resumed.context.recipient, 'Kwame');
  assert.equal(resumed.context.amount, '75');
});

test('handleFsmMessage drives multi-step flow with cancellation', async () => {
  const mockRedis = createMockRedis();
  const replies = [];
  const notify = async (to, text) => replies.push(text);

  // Start in AWAITING_AMOUNT
  await saveSession(TEST_PHONE, {
    state: STATES.AWAITING_AMOUNT,
    context: { recipient: 'Fatima' },
  }, { redis: mockRedis });

  // Step 1: User provides amount
  replies.length = 0;
  let res = await handleFsmMessage(TEST_PHONE, '25 XLM', {
    notify,
    redis: mockRedis,
  });
  assert.equal(res.handled, true);
  assert.equal(res.state, STATES.AWAITING_CONFIRMATION);
  assert.ok(replies[0].includes('Send 25 XLM to Fatima'));
  assert.ok(replies[0].includes('Reply YES to confirm'));

  // Step 2: User confirms
  replies.length = 0;
  res = await handleFsmMessage(TEST_PHONE, 'YES', {
    notify,
    redis: mockRedis,
  });
  assert.equal(res.handled, true);
  assert.equal(res.state, STATES.AWAITING_PIN);
  assert.ok(replies[0].includes('enter your 4-digit PIN'));

  // Step 3: User cancels
  replies.length = 0;
  res = await handleFsmMessage(TEST_PHONE, 'cancel', {
    notify,
    redis: mockRedis,
  });
  assert.equal(res.handled, true);
  assert.equal(res.state, STATES.IDLE);
  assert.ok(replies[0].includes('Transaction cancelled'));

  // Verify session is cleared in Redis
  const finalSession = await getSession(TEST_PHONE, { redis: mockRedis });
  assert.equal(finalSession.state, STATES.IDLE);
});

test('handleFsmMessage handles expired session with interactive resume response', async () => {
  const mockRedis = createMockRedis();
  const replies = [];
  const notify = async (to, text) => replies.push(text);

  // Expired session in Redis
  const past = Date.now() - 20 * 60 * 1000;
  await mockRedis.set(
    `whatsapp:fsm:session:${TEST_PHONE}`,
    JSON.stringify({
      phoneNumber: TEST_PHONE,
      state: STATES.AWAITING_CONFIRMATION,
      context: { recipient: 'Zainab', amount: '200', asset: 'XLM' },
      expiresAt: new Date(past + 10 * 60 * 1000).toISOString(),
    }),
    'EX',
    600
  );

  // User sends a message -> receives informative resume prompt
  replies.length = 0;
  let res = await handleFsmMessage(TEST_PHONE, 'hello', {
    notify,
    redis: mockRedis,
  });
  assert.equal(res.handled, true);
  assert.equal(res.promptType, 'resume_inquiry');
  assert.ok(replies[0].includes('Zainab'));
  assert.ok(replies[0].includes('200 XLM'));

  // User replies YES -> session is resumed
  replies.length = 0;
  res = await handleFsmMessage(TEST_PHONE, 'YES', {
    notify,
    redis: mockRedis,
  });
  assert.equal(res.handled, true);
  assert.equal(res.state, STATES.AWAITING_CONFIRMATION);
  assert.ok(replies[0].includes('Resumed'));
  assert.ok(replies[0].includes('Zainab'));

  const active = await getSession(TEST_PHONE, { redis: mockRedis });
  assert.equal(active.state, STATES.AWAITING_CONFIRMATION);
  assert.equal(active.context.recipient, 'Zainab');
});

test('conversational flow integration with processMessage across steps', async () => {
  const { processMessage } = require('../src/whatsapp/assistant.service');
  const phone = '+2348001122339';
  let userState = {
    id: 'u_fsm_int_1',
    phoneNumber: phone,
    whatsappName: 'Charlie',
    pendingSend: null,
    locale: 'en',
  };

  const fakeDb = {
    user: {
      findUnique: async () => userState,
      create: async ({ data }) => {
        userState = { id: 'u_fsm_int_1', ...data };
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
  const notify = async (to, text) => replies.push(text);

  // Step 1: User says "send to Ada" without amount
  await processMessage(phone, 'Charlie', 'send to Ada', {
    notify,
    prisma: fakeDb,
  });

  assert.equal(replies.length, 1);
  assert.ok(replies[0].includes('How much would you like to send to Ada'));

  // Verify FSM session state is AWAITING_AMOUNT
  const sessionStep1 = await getSession(phone);
  assert.equal(sessionStep1.state, STATES.AWAITING_AMOUNT);
  assert.equal(sessionStep1.context.recipient, 'Ada');

  // Step 2: User provides amount "50 XLM"
  replies.length = 0;
  await processMessage(phone, 'Charlie', '50 XLM', {
    notify,
    prisma: fakeDb,
  });

  assert.equal(replies.length, 1);
  assert.ok(replies[0].includes('Send 50 XLM to Ada'));
  assert.ok(replies[0].includes('Reply YES to confirm'));

  const sessionStep2 = await getSession(phone);
  assert.equal(sessionStep2.state, STATES.AWAITING_CONFIRMATION);
  assert.equal(sessionStep2.context.amount, '50');

  // Step 3: User confirms with "YES"
  replies.length = 0;
  await processMessage(phone, 'Charlie', 'YES', {
    notify,
    prisma: fakeDb,
  });

  assert.equal(replies.length, 1);
  assert.ok(replies[0].includes('enter your 4-digit PIN'));

  const sessionStep3 = await getSession(phone);
  assert.equal(sessionStep3.state, STATES.AWAITING_PIN);
});

