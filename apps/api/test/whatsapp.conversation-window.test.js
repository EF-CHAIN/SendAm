const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const {
  isWithinConversationWindow,
  sendTextMessage,
  sendTemplateMessage,
  CONVERSATION_WINDOW_MS,
} = require('../src/services/whatsapp.service');

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

  assert.equal(result.id, 'sim_1');
  assert.equal(result.text, 'Hello inside window');
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

  assert.equal(result, null);
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

  assert.equal(result.id, 'sim_template_1');
  assert.equal(result.text.includes('[Template: sendam_transaction_notice]'), true);
});
