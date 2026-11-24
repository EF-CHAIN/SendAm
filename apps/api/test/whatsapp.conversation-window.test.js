const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const {
  sendTextMessage,
} = require('../src/services/whatsapp.service');
const { isWithinConversationWindow } = require('../src/services/whatsappWindowTracker');

test('isWithinConversationWindow correctly identifies timestamps within 24h', () => {
  const now = Date.now();
  assert.equal(isWithinConversationWindow(new Date(now - 1000)), true);
  assert.equal(isWithinConversationWindow(new Date(now - 12 * 60 * 60 * 1000)), true);
  assert.equal(isWithinConversationWindow(new Date(now - 25 * 60 * 60 * 1000)), false);
  assert.equal(isWithinConversationWindow(null), false);
  assert.equal(isWithinConversationWindow(undefined), false);
});

test('sendTextMessage permits free-form message inside 24h window', async () => {
  const dbCalls = [];
  const fakePrisma = {
    simMessage: {
      create: async (args) => {
        dbCalls.push(args);
        return { id: 'sim_1', ...args.data };
      },
    },
  };

  const result = await sendTextMessage('+1234567890', 'Hello inside window', {
    messageTransport: 'sim',
    prisma: fakePrisma,
    enforceWindow: true,
    lastCustomerInteractionAt: new Date(),
  });

  assert.equal(result.outcome, 'accepted');
  assert.equal(result.data.id, 'sim_1');
  assert.equal(result.data.text, 'Hello inside window');
});

test('sendTextMessage rejects free-form message outside 24h window when no template is supplied', async () => {
  const notificationsCreated = [];
  const fakePrisma = {
    notification: {
      create: async (args) => {
        notificationsCreated.push(args);
        return { id: 'notif_1', ...args.data };
      },
    },
  };

  const result = await sendTextMessage('+1234567890', 'Hello outside window', {
    messageTransport: 'sim',
    prisma: fakePrisma,
    notification: { userId: 'u1', type: 'marketing' },
    enforceWindow: true,
    lastCustomerInteractionAt: new Date(Date.now() - 30 * 60 * 60 * 1000), // 30h ago
  });

  assert.equal(result.outcome, 'permanent_failure');
  assert.equal(result.error.kind, 'conversation_window');
  assert.equal(notificationsCreated.length, 1);
  assert.equal(notificationsCreated[0].data.status, 'failed');
  assert.equal(notificationsCreated[0].data.error.includes('Meta customer service window expired'), true);
});

test('sendTextMessage falls back to approved template message when outside 24h window', async () => {
  const simCalls = [];
  const fakePrisma = {
    simMessage: {
      create: async (args) => {
        simCalls.push(args);
        return { id: 'sim_template_1', ...args.data };
      },
    },
  };

  const result = await sendTextMessage('+1234567890', 'Fallback message', {
    messageTransport: 'sim',
    prisma: fakePrisma,
    enforceWindow: true,
    lastCustomerInteractionAt: new Date(Date.now() - 30 * 60 * 60 * 1000),
    templateName: 'sendam_transaction_notice',
    templateLanguage: 'en',
    templateComponents: [{ type: 'body', parameters: [{ type: 'text', text: '10 USDC' }] }],
  });

  assert.equal(result.outcome, 'accepted');
  assert.equal(result.data.id, 'sim_template_1');
  assert.equal(result.data.text.includes('[Template: sendam_transaction_notice]'), true);
});

// ---- #969: Redis-backed last-inbound tracking -------------------------------

const tracker = require('../src/services/whatsappWindowTracker');

const fakeRedis = () => {
  const store = new Map();
  const calls = [];
  return {
    store,
    calls,
    status: 'ready',
    set: async (key, value, ...args) => { calls.push({ op: 'set', key, value, args }); store.set(key, value); return 'OK'; },
    get: async (key) => { calls.push({ op: 'get', key }); return store.get(key) ?? null; },
  };
};

const simPrisma = (sink) => ({
  simMessage: { create: async (args) => { sink.push(args.data); return { id: `sim_${sink.length}`, ...args.data }; } },
  notification: { create: async (args) => ({ id: 'notif_1', ...args.data }) },
});

test('isWithinConversationWindow accepts ISO strings and epoch ms (JSON-serialized job data)', () => {
  const recent = new Date(Date.now() - 60 * 1000);
  assert.equal(isWithinConversationWindow(recent.toISOString()), true);
  assert.equal(isWithinConversationWindow(recent.getTime()), true);
  assert.equal(isWithinConversationWindow(new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()), false);
  assert.equal(isWithinConversationWindow('not a date'), false);
});

test('tracker keys inbound wa_id and outbound E.164 numbers to the same entry, with a TTL', async () => {
  const redis = fakeRedis();
  const now = Date.now();
  assert.equal(await tracker.setLastInboundAt('2348012345678', { redis, now }), true);
  assert.deepEqual(redis.calls[0].args, ['EX', tracker.KEY_TTL_SECONDS]);

  const fromOutbound = await tracker.getLastInboundAt('+234 801 234 5678', { redis });
  assert.equal(fromOutbound.getTime(), now);
});

test('tracker degrades to unknown when Redis is unavailable or failing', async () => {
  assert.equal(await tracker.setLastInboundAt('+2348012345678', { redis: null }), false);
  assert.equal(await tracker.getLastInboundAt('+2348012345678', { redis: null }), null);
  const broken = { status: 'ready', get: async () => { throw new Error('ECONNRESET'); }, set: async () => { throw new Error('ECONNRESET'); } };
  assert.equal(await tracker.setLastInboundAt('+2348012345678', { redis: broken }), false);
  assert.equal(await tracker.getLastInboundAt('+2348012345678', { redis: broken }), null);
});

test('resolveLastInboundAt prefers the most recent of Redis and the caller fallback', async () => {
  const redis = fakeRedis();
  const recent = Date.now() - 60 * 1000;
  await tracker.setLastInboundAt('+2348012345678', { redis, now: recent });
  const stale = new Date(Date.now() - 30 * 60 * 60 * 1000);
  assert.equal((await tracker.resolveLastInboundAt('+2348012345678', stale, { redis })).getTime(), recent);
  assert.equal((await tracker.resolveLastInboundAt('+2348099999999', stale, { redis })).getTime(), stale.getTime());
  assert.equal(await tracker.resolveLastInboundAt('+2348099999999', null, { redis }), null);
});

test('outbound notification outside the window (per Redis) is sent as the fallback template', async () => {
  const sent = [];
  const result = await sendTextMessage('+2348012345678', 'You received 10 USDC.\nRef: abc', {
    messageTransport: 'sim',
    prisma: simPrisma(sent),
    notification: { userId: 'u1', type: 'deposit_received' },
    fallbackTemplateName: 'sendam_notification',
    resolveLastInboundAt: async () => new Date(Date.now() - 30 * 60 * 60 * 1000),
  });

  assert.equal(result.outcome, 'accepted');
  assert.equal(result.template, 'sendam_notification');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, '[Template: sendam_notification]');
});

test('outbound notification inside the window (per Redis) is sent free-form even if the caller value is stale', async () => {
  const sent = [];
  const result = await sendTextMessage('+2348012345678', 'You received 10 USDC.', {
    messageTransport: 'sim',
    prisma: simPrisma(sent),
    notification: { userId: 'u1', type: 'deposit_received' },
    fallbackTemplateName: 'sendam_notification',
    lastCustomerInteractionAt: new Date(Date.now() - 30 * 60 * 60 * 1000),
    resolveLastInboundAt: (to, fallback) => tracker.resolveLastInboundAt(to, fallback, {
      redis: { status: 'ready', get: async () => String(Date.now() - 60 * 1000) },
    }),
  });

  assert.equal(result.outcome, 'accepted');
  assert.equal(result.template, undefined);
  assert.equal(sent[0].text, 'You received 10 USDC.');
});

test('without a configured fallback template, notifications keep the previous free-form behaviour', async () => {
  const sent = [];
  let resolverCalled = false;
  const result = await sendTextMessage('+2348012345678', 'Hello', {
    messageTransport: 'sim',
    prisma: simPrisma(sent),
    notification: { userId: 'u1', type: 'deposit_received' },
    fallbackTemplateName: null,
    resolveLastInboundAt: async () => { resolverCalled = true; return null; },
  });

  assert.equal(result.outcome, 'accepted');
  assert.equal(resolverCalled, false, 'no window lookup when there is nothing to fall back to');
  assert.equal(sent[0].text, 'Hello');
});

test('fallback template parameter has no newlines or tabs and is length-capped', () => {
  const { buildFallbackTemplateComponents } = require('../src/services/whatsapp.service');
  const [component] = buildFallbackTemplateComponents(`line one\n\tline     two ${'x'.repeat(2000)}`);
  const { text } = component.parameters[0];
  assert.equal(/[\n\t]| {5,}/.test(text), false);
  assert.ok(text.startsWith('line one line two'));
  assert.equal(text.length, 1000);
});
