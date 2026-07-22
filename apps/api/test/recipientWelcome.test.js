const { test } = require('node:test');
const assert = require('node:assert/strict');

const { claimWelcome, sendWelcomeForDeposit, WELCOME_MESSAGE } = require('../src/whatsapp/recipientWelcome');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const stubPrisma = (counts) => {
  const calls = [];
  return {
    calls,
    user: {
      updateMany: async (args) => {
        calls.push(args);
        return { count: counts.shift() ?? 0 };
      },
    },
  };
};

// ---------------------------------------------------------------------------
// claimWelcome
// ---------------------------------------------------------------------------
test('claimWelcome: fresh user — sets welcomeSentAt and returns true', async () => {
  const prisma = stubPrisma([1]);
  const before = Date.now();

  const won = await claimWelcome({ prisma, userId: 'u_1' });

  assert.equal(won, true);
  assert.equal(prisma.calls.length, 1);
  assert.equal(prisma.calls[0].where.id, 'u_1');
  assert.equal(prisma.calls[0].where.welcomeSentAt, null);
  assert.ok(prisma.calls[0].data.welcomeSentAt instanceof Date);
  assert.ok(prisma.calls[0].data.welcomeSentAt.getTime() >= before);
});

test('claimWelcome: already welcomed — returns false', async () => {
  const prisma = stubPrisma([0]);

  const won = await claimWelcome({ prisma, userId: 'u_1' });

  assert.equal(won, false);
  assert.equal(prisma.calls.length, 1);
  assert.equal(prisma.calls[0].where.welcomeSentAt, null);
});

test('claimWelcome: double-deposit race — exactly one winner', async () => {
  const prisma = stubPrisma([1, 0]);

  const [first, second] = await Promise.all([
    claimWelcome({ prisma, userId: 'u_1' }),
    claimWelcome({ prisma, userId: 'u_1' }),
  ]);

  assert.deepEqual([first, second].sort(), [false, true]);
  assert.equal(prisma.calls.length, 2);
  assert.ok(prisma.calls.every((c) => c.where.welcomeSentAt === null));
});

// ---------------------------------------------------------------------------
// sendWelcomeForDeposit
// ---------------------------------------------------------------------------
test('sendWelcomeForDeposit: fresh user — sends welcome and returns true', async () => {
  const prisma = stubPrisma([1]);
  const sent = [];
  const notify = async (phone, text) => sent.push({ phone, text });

  const result = await sendWelcomeForDeposit({
    user: { id: 'u_1' },
    phoneNumber: '+2348000000001',
    prisma,
    notify,
  });

  assert.equal(result, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].phone, '+2348000000001');
  assert.equal(sent[0].text, WELCOME_MESSAGE);
});

test('sendWelcomeForDeposit: existing user — no welcome sent, returns false', async () => {
  const prisma = stubPrisma([0]);
  const sent = [];
  const notify = async (phone, text) => sent.push({ phone, text });

  const result = await sendWelcomeForDeposit({
    user: { id: 'u_1' },
    phoneNumber: '+2348000000001',
    prisma,
    notify,
  });

  assert.equal(result, false);
  assert.equal(sent.length, 0);
});

test('sendWelcomeForDeposit: rapid double-deposit — exactly one welcome sent', async () => {
  const prisma = stubPrisma([1, 0]);
  const sent = [];
  const notify = async (phone, text) => sent.push({ phone, text });

  const [first, second] = await Promise.all([
    sendWelcomeForDeposit({ user: { id: 'u_1' }, phoneNumber: '+2348000000001', prisma, notify }),
    sendWelcomeForDeposit({ user: { id: 'u_1' }, phoneNumber: '+2348000000001', prisma, notify }),
  ]);

  assert.deepEqual([first, second].sort(), [false, true]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, WELCOME_MESSAGE);
});

test('sendWelcomeForDeposit: welcome is sent before the deposit alert', async () => {
  const prisma = stubPrisma([1]);
  const messages = [];
  const notify = async (phone, text) => messages.push(text);

  await sendWelcomeForDeposit({ user: { id: 'u_1' }, phoneNumber: '+2348000000001', prisma, notify });

  // Simulate the deposit poller sending the alert after the welcome check
  await notify('+2348000000001', 'You received 50 XLM.');

  assert.equal(messages.length, 2);
  assert.equal(messages[0], WELCOME_MESSAGE);
  assert.equal(messages[1], 'You received 50 XLM.');
});
