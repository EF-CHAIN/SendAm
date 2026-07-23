const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Set env vars BEFORE any src modules are loaded
// ---------------------------------------------------------------------------
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.JWT_SECRET = 'b'.repeat(64);
process.env.ADMIN_PASSWORD = 'testpassword123';
process.env.NODE_ENV = 'development';
process.env.PIN_PEPPER = 'test-pepper';

// Pre-compute a known PIN hash for test PIN '1234'
const TEST_PIN = '1234';
const TEST_PIN_HASH = crypto.createHmac('sha256', 'test-pepper').update(TEST_PIN).digest('hex');

// ---------------------------------------------------------------------------
// Module-level mock injection
// ---------------------------------------------------------------------------
const injectMock = (relativeFromSrc, exports) => {
  const abs = path.resolve(__dirname, '../src', `${relativeFromSrc}.js`);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports };
};

// --- Prisma in-memory stub ------------------------------------------------
const users = new Map();
let userIdSeq = 1;

const prismaMock = {
  user: {
    findUnique: async ({ where }) => {
      if (where.phoneNumber) {
        for (const u of users.values()) {
          if (u.phoneNumber === where.phoneNumber) return { ...u };
        }
        return null;
      }
      if (where.id) return users.get(where.id) ? { ...users.get(where.id) } : null;
      return null;
    },
    create: async ({ data }) => {
      const id = userIdSeq++;
      const user = { phoneNumber: data.phoneNumber, whatsappName: data.whatsappName || null,
        pendingSend: null, pinHash: null, kycTier: 1, riskScore: 0, ...data, id };
      users.set(id, user);
      return { ...user };
    },
    update: async ({ where, data }) => {
      const user = users.get(where.id);
      if (!user) throw new Error(`User ${where.id} not found`);
      Object.assign(user, data);
      return { ...user };
    },
    updateMany: async ({ where, data }) => {
      const user = users.get(where.id);
      if (!user || user.pendingSend == null) return { count: 0 };
      Object.assign(user, data);
      return { count: 1 };
    },
    count: async () => 0,
    findMany: async () => [],
  },
  alias: { findUnique: async () => null },
  processedMessage: {
    _seen: new Set(),
    create: async ({ data }) => {
      if (prismaMock.processedMessage._seen.has(data.messageId)) {
        throw Object.assign(new Error('Unique constraint'), { code: 'P2002' });
      }
      prismaMock.processedMessage._seen.add(data.messageId);
      return data;
    },
  },
  rateLimitHit: {
    findUnique: async () => null,
    upsert: async ({ create }) => ({ ...create, resetAt: new Date(Date.now() + 60_000) }),
  },
  transaction: { findMany: async () => [] },
  kycProfile: {
    findUnique: async ({ where }) => {
      if (where.userId) return { id: 'kyc_1', userId: where.userId, tier: 1, status: 'approved', riskScore: 10 };
      return null;
    },
  },
  $queryRaw: async () => [],
};

injectMock('common/prisma', prismaMock);

// --- @prisma/client namespace ----------------------------------------------
const prismaClientPath = require.resolve('@prisma/client');
require.cache[prismaClientPath] = {
  id: prismaClientPath, filename: prismaClientPath, loaded: true,
  exports: { Prisma: { DbNull: null, AnyNull: null } },
};

// --- Stellar SDK (config/stellar.js creates Horizon.Server at load) -------
injectMock('config/stellar', {
  server: { loadAccount: async () => ({}), fetchBaseFee: async () => 100, submitTransaction: async () => ({}) },
  StellarSdk: {
    Keypair: {
      random: () => ({ publicKey: () => 'G' + 'A'.repeat(55), secret: () => 'S' + 'A'.repeat(55) }),
      fromSecret: () => ({ publicKey: () => 'G' + 'A'.repeat(55) }),
    },
    Asset: { native: () => ({}) },
    Networks: { TESTNET: 'Testnet SDF Network ; September 2015' },
    StrKey: { isValidEd25519PublicKey: () => true },
    TransactionBuilder: class { addOperation() { return this; } setTimeout() { return this; } build() { return {}; } },
    Operation: { payment: () => ({}) },
  },
});

// --- Outbound WhatsApp (HTTP boundary) ------------------------------------
const sentMessages = [];
const sendTextMessageMock = async (to, body) => { sentMessages.push({ to, body }); };

injectMock('services/whatsapp.service', { sendTextMessage: sendTextMessageMock });

// --- External service clients (all off by default) ------------------------
injectMock('services/serviceClient', {
  createServiceClient: () => ({ enabled: false, get: async () => ({ ok: false }), post: async () => ({ ok: false }) }),
});
injectMock('services/aiClient', { createAiClient: () => ({ enabled: false }), aiClient: { enabled: false } });
injectMock('services/nsClient', { createNsClient: () => ({ enabled: false }), nsClient: { enabled: false } });
injectMock('services/policyClient', {
  createPolicyClient: () => ({ enabled: false }),
  policyClient: { enabled: false, checkPolicy: async () => null },
});

// --- Compliance (local fallback, no external policy call) ------------------
injectMock('compliance/compliance.service', {
  enforceTransactionPolicy: async () => ({ riskScore: 10 }),
});

// --- Payment orchestrator (only this boundary is faked) -------------------
const paymentResults = [];
const mockExecutePayment = async (input) => {
  const txId = `tx_${paymentResults.length + 1}`;
  const result = {
    transaction: {
      id: txId, _id: txId, userId: input.sender.id, type: 'send',
      amount: String(input.amount), asset: input.asset || 'XLM',
      recipientPhoneNumber: input.recipientPhoneNumber,
      destination: input.destination, rail: 'stellar',
      routeType: input.routeType || 'domestic',
      status: 'success', txHash: `hash_${txId}`,
      explorerUrl: `https://stellar.expert/testnet/tx/hash_${txId}`,
    },
    quote: { id: `quote_${txId}` },
    receipt: {
      transactionId: txId, status: 'success',
      amount: String(input.amount), asset: input.asset || 'XLM',
      rail: 'stellar',
      receiptUrl: `https://stellar.expert/testnet/tx/hash_${txId}`,
    },
  };
  paymentResults.push(result);
  return result;
};

injectMock('payment/payment.orchestrator', {
  executePayment: mockExecutePayment,
  calculateFee: (amount) => (Number(amount) * 0.01).toFixed(2),
  buildReceipt: ({ transaction }) => ({
    transactionId: transaction.id, status: transaction.status,
    amount: transaction.amount, asset: transaction.asset,
    rail: transaction.rail, receiptUrl: transaction.explorerUrl,
  }),
});

// --- Stellar adapter ------------------------------------------------------
injectMock('wallet/stellar.adapter', {
  validateAddress: () => true,
  createWallet: () => ({ publicKey: 'G' + 'A'.repeat(55), secretKey: 'S' + 'A'.repeat(55) }),
});

// --- Pricing (quote without external HTTP) --------------------------------
injectMock('pricing/pricing.service', {
  createQuote: async () => ({ id: `quote_${Date.now()}` }),
  getExchangeRate: async () => 1,
});

// --- Pending claim (atomic race guard) ------------------------------------
const pendingClaimResults = [];
injectMock('whatsapp/pendingClaim', {
  claimPendingSend: async ({ prisma: _prisma, Prisma: _Prisma, userId: _userId }) => {
    const result = pendingClaimResults.shift();
    return result !== undefined ? result : true;
  },
});

// --- Queue service (synchronous inline execution) -------------------------
const queueProcessors = new Map();
injectMock('queues/queue.service', {
  registerProcessor: (name, fn) => { queueProcessors.set(name, fn); },
  enqueue: async (name, _jobName, data) => {
    const processor = queueProcessors.get(name);
    if (processor) await processor({ name: _jobName, data });
  },
});

// --- Audit (no-op) --------------------------------------------------------
injectMock('common/audit.service', { writeAuditLog: async () => {} });

// --- Records helpers -------------------------------------------------------
injectMock('common/records', {
  withIdAlias: (r) => r ? { ...r, _id: r.id } : r,
  withIdAliases: (rs) => rs.map((r) => ({ ...r, _id: r.id })),
});

// --- Rate-limit consume (no-op) --------------------------------------------
injectMock('services/rateLimit.service', { consume: async () => ({ totalHits: 1 }) });

// --- WhatsApp queue processor (register before app loads) ------------------
const { registerWhatsAppJobs } = require('../src/jobs/whatsapp.jobs');
registerWhatsAppJobs();

// --- Build the Express app ------------------------------------------------
const app = require('../src/app');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const WAIT_TIMEOUT = 2000;

const waitFor = async (predicate, ms = WAIT_TIMEOUT) => {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const buildWebhookPayload = (messageId, from, text, whatsappName = 'Test User') => ({
  object: 'whatsapp_business_account',
  entry: [{
    changes: [{
      value: {
        messaging_product: 'whatsapp',
        contacts: [{ profile: { name: whatsappName } }],
        messages: [{ id: messageId, from, type: 'text', text: { body: text } }],
      },
    }],
  }],
});

const postWebhook = async (body) => {
  const res = await fetch(`${baseUrl}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  // The controller sends 200 before the processor runs (real app behaviour).
  // Yield the event loop so the inline processor finishes before the caller
  // observes the response and sends the next request.
  await new Promise((r) => setImmediate(r));
  return res;
};

const seedUser = (phone, name = 'Test User') => {
  const id = userIdSeq++;
  users.set(id, { id, phoneNumber: phone, whatsappName: name, pendingSend: null, pinHash: TEST_PIN_HASH, kycTier: 1, riskScore: 0 });
  return users.get(id);
};

let server;
let baseUrl;

const setup = async () => {
  const http = require('node:http');
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
};

const teardown = async () => {
  if (server) await new Promise((r) => server.close(r));
};

const resetState = () => {
  users.clear();
  userIdSeq = 1;
  sentMessages.length = 0;
  paymentResults.length = 0;
  pendingClaimResults.length = 0;
  prismaMock.processedMessage._seen.clear();
};

// ---------------------------------------------------------------------------
// Test 1: full happy path
// ---------------------------------------------------------------------------
test('full happy path: webhook POST -> parse -> confirmation -> PIN -> receipt', async () => {
  resetState();
  pendingClaimResults.push(true);

  await setup();
  try {
    const phone = '+2348000000001';
    const dest = 'GCXQJ7E6C6TQX7GVV3T6HX3Q7H3P6G6X7Q7J7E6C6TQX7GVV3T6HX3Q7';

    seedUser(phone);

    const res1 = await postWebhook(buildWebhookPayload('msg_001', phone, `send 100 XLM to ${dest}`));
    assert.equal(res1.status, 200);

    await waitFor(() => sentMessages.length >= 1);
    assert.ok(sentMessages[0].body.includes('confirm this payment'), 'confirmation prompt sent');
    assert.ok(sentMessages[0].body.includes('100'), 'amount in confirmation');
    assert.ok(sentMessages[0].body.includes('XLM'), 'asset in confirmation');

    const res2 = await postWebhook(buildWebhookPayload('msg_002', phone, '1234'));
    assert.equal(res2.status, 200);

    await waitFor(() => sentMessages.length >= 2);
    assert.ok(sentMessages[1].body.includes('Payment success'), 'receipt sent');
    assert.ok(sentMessages[1].body.includes('tx_1'), 'transaction id in receipt');
    assert.equal(paymentResults.length, 1, 'payment executed exactly once');
  } finally {
    await teardown();
  }
});

// ---------------------------------------------------------------------------
// Test 2: duplicate webhook delivery does not double-send
// ---------------------------------------------------------------------------
test('duplicate webhook delivery (same message id) does not double-send', async () => {
  resetState();

  await setup();
  try {
    const phone = '+2348000000002';
    const dest = 'GCXQJ7E6C6TQX7GVV3T6HX3Q7H3P6G6X7Q7J7E6C6TQX7GVV3T6HX3Q7';
    const payload = buildWebhookPayload('msg_dup_001', phone, `send 50 XLM to ${dest}`);

    seedUser(phone);

    const res1 = await postWebhook(payload);
    assert.equal(res1.status, 200);

    await waitFor(() => sentMessages.length >= 1);
    assert.ok(sentMessages[0].body.includes('confirm this payment'));

    const res2 = await postWebhook(payload);
    assert.equal(res2.status, 200);

    await new Promise((r) => setTimeout(r, 100));
    assert.equal(sentMessages.length, 1, 'duplicate delivery did not produce a second reply');
  } finally {
    await teardown();
  }
});

// ---------------------------------------------------------------------------
// Test 3: two rapid PIN replies produce exactly one payment
// ---------------------------------------------------------------------------
test('two rapid PIN replies produce exactly one payment (atomic claim)', async () => {
  resetState();
  pendingClaimResults.push(true);
  pendingClaimResults.push(false);

  await setup();
  try {
    const phone = '+2348000000003';
    const dest = 'GCXQJ7E6C6TQX7GVV3T6HX3Q7H3P6G6X7Q7J7E6C6TQX7GVV3T6HX3Q7';

    seedUser(phone);

    await postWebhook(buildWebhookPayload('msg_race_001', phone, `send 200 XLM to ${dest}`));
    await waitFor(() => sentMessages.length >= 1);
    assert.ok(sentMessages[0].body.includes('confirm this payment'), 'confirmation sent');

    await postWebhook(buildWebhookPayload('msg_race_002', phone, '1234'));
    await postWebhook(buildWebhookPayload('msg_race_003', phone, '1234'));

    await waitFor(() => sentMessages.length >= 3);

    const paymentReplies = sentMessages.filter((m) => /payment/i.test(m.body));
    const successReplies = paymentReplies.filter((m) => m.body.includes('success'));
    const rejectedReplies = paymentReplies.filter((m) => m.body.includes('already processed'));

    assert.equal(successReplies.length, 1, 'exactly one payment succeeded');
    assert.equal(rejectedReplies.length, 1, 'second PIN was rejected');
    assert.equal(paymentResults.length, 1, 'payment executed exactly once');
  } finally {
    await teardown();
  }
});
