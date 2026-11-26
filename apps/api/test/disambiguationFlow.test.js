const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/db';

const {
  detectAmbiguousIntent,
  buildDisambiguationOptions,
  formatDisambiguationPrompt,
} = require('../src/whatsapp/disambiguation');
const { processMessage } = require('../src/whatsapp/assistant.service');

describe('Conversational Disambiguation Flow (#980)', () => {
  test('detectAmbiguousIntent detects ambiguous inputs without explicit currency', () => {
    // Ambiguous
    const amb1 = detectAmbiguousIntent('Send 50');
    assert.ok(amb1);
    assert.equal(amb1.amount, '50');
    assert.equal(amb1.recipient, null);

    const amb2 = detectAmbiguousIntent('Send 50 to Kofi');
    assert.ok(amb2);
    assert.equal(amb2.amount, '50');
    assert.equal(amb2.recipient, 'Kofi');

    const amb3 = detectAmbiguousIntent('pay 100 to Mama');
    assert.ok(amb3);
    assert.equal(amb3.amount, '100');
    assert.equal(amb3.recipient, 'Mama');

    // Unambiguous (has explicit currency)
    assert.equal(detectAmbiguousIntent('Send 50 USD to Kofi'), null);
    assert.equal(detectAmbiguousIntent('Send 50000 NGN to Kofi'), null);
    assert.equal(detectAmbiguousIntent('Transfer 50 cedis to Kofi'), null);
    assert.equal(detectAmbiguousIntent('Send 100 XLM to Bob'), null);
    assert.equal(detectAmbiguousIntent('pay 25 USDC to Alice'), null);
  });

  test('buildDisambiguationOptions includes USD, NGN, and GHS quick choices', () => {
    const options = buildDisambiguationOptions('50');
    assert.equal(options.length, 3);

    const usdOpt = options.find((o) => o.currency === 'USD');
    const ngnOpt = options.find((o) => o.currency === 'NGN');
    const ghsOpt = options.find((o) => o.currency === 'GHS');

    assert.ok(usdOpt);
    assert.equal(usdOpt.label, '50 USD ($)');
    assert.equal(usdOpt.amount, '50');

    assert.ok(ngnOpt);
    assert.equal(ngnOpt.label, '50,000 NGN (₦)');
    assert.equal(ngnOpt.amount, '50000');

    assert.ok(ghsOpt);
    assert.equal(ghsOpt.label, '50 GHS (₵)');
    assert.equal(ghsOpt.amount, '50');
  });

  test('formatDisambiguationPrompt formats choices properly', () => {
    const options = buildDisambiguationOptions('50');
    const prompt = formatDisambiguationPrompt('50', options);

    assert.ok(prompt.includes('50 USD ($)'));
    assert.ok(prompt.includes('50,000 NGN (₦)'));
    assert.ok(prompt.includes('50 GHS (₵)'));
    assert.ok(prompt.includes('Reply with 1, 2, or 3'));
  });

  test('ambiguous input "Send 50" triggers clarification dialog before creating payment quotes', async () => {
    const phone = '+2348001112233';
    let userState = {
      id: 'u_disambig_1',
      phoneNumber: phone,
      whatsappName: 'Kofi',
      pendingSend: null,
      locale: 'en',
    };

    let quoteCreated = false;

    const fakeDb = {
      user: {
        findUnique: async () => userState,
        create: async ({ data }) => {
          userState = { id: 'u_disambig_1', ...data };
          return userState;
        },
        update: async ({ data }) => {
          Object.assign(userState, data);
          return userState;
        },
      },
      quote: {
        create: async () => {
          quoteCreated = true;
          return { id: 'q_1' };
        },
      },
      transaction: { findFirst: async () => null, findMany: async () => [] },
      alias: { findFirst: async () => null, findUnique: async () => null },
    };

    const replies = [];
    const notify = async (to, text) => replies.push(text);

    // 1. User types "Send 50"
    await processMessage(phone, 'Kofi', 'Send 50', {
      notify,
      prisma: fakeDb,
    });

    // Clarification dialog triggered
    assert.equal(replies.length, 1);
    assert.ok(replies[0].includes('Which currency and corridor did you mean for 50?'));
    assert.ok(replies[0].includes('50 USD ($)'));
    assert.ok(replies[0].includes('50,000 NGN (₦)'));
    assert.ok(replies[0].includes('50 GHS (₵)'));

    // Crucial acceptance criterion: No payment quote created yet!
    assert.equal(quoteCreated, false);
    assert.equal(userState.pendingSend.step, 'AWAITING_DISAMBIGUATION');

    // 2. User selects option 2: [50,000 NGN (₦)]
    replies.length = 0;
    await processMessage(phone, 'Kofi', '2', {
      notify,
      prisma: fakeDb,
    });

    assert.equal(replies.length, 1);
    assert.ok(replies[0].includes('50,000 NGN (₦)'));
    assert.ok(replies[0].includes('Who would you like to send this to?'));
    assert.equal(userState.pendingSend.step, 'AWAITING_RECIPIENT');
    assert.equal(userState.pendingSend.amount, '50000');
    assert.equal(userState.pendingSend.asset, 'NGN');
  });

  test('disambiguation flow with recipient specified triggers clarification then advances', async () => {
    const phone = '+2348002223344';
    let userState = {
      id: 'u_disambig_2',
      phoneNumber: phone,
      whatsappName: 'Chidi',
      pendingSend: null,
      locale: 'en',
    };

    let quotesCreated = [];

    const fakeDb = {
      user: {
        findUnique: async () => userState,
        create: async ({ data }) => {
          userState = { id: 'u_disambig_2', ...data };
          return userState;
        },
        update: async ({ data }) => {
          Object.assign(userState, data);
          return userState;
        },
      },
      quote: {
        create: async ({ data }) => {
          quotesCreated.push(data);
          return { id: 'q_2', expiresAt: new Date(Date.now() + 60000), fee: '0.1' };
        },
      },
      transaction: { findFirst: async () => null, findMany: async () => [] },
      alias: {
        findUnique: async () => ({ alias: 'chidi', target: 'GCFUBXHMSAG6SQ64VDW24EATZ6VSCCDGAN57X2HGBUXLUUPUC4XR5S6Z' }),
        findFirst: async () => null,
      },
    };

    const replies = [];
    const notify = async (to, text) => replies.push(text);

    // 1. User types "Send 50 to Chidi"
    await processMessage(phone, 'Chidi', 'Send 50 to Chidi', {
      notify,
      prisma: fakeDb,
    });

    assert.equal(replies.length, 1);
    assert.ok(replies[0].includes('Which currency and corridor did you mean for 50?'));
    assert.equal(quotesCreated.length, 0, 'Quote must NOT be created before disambiguation');

    // 2. User selects option 1: 50 USD ($)
    replies.length = 0;
    await processMessage(phone, 'Chidi', '1', {
      notify,
      prisma: fakeDb,
    });

    // Advanced to confirmation
    assert.equal(replies.length, 1);
    assert.ok(replies[0].includes('HIGH-RISK RECIPIENT DETECTED') || replies[0].includes('confirm this payment'));
  });

  test('cancelling disambiguation cancels the payment', async () => {
    const phone = '+2348003334455';
    let userState = {
      id: 'u_disambig_3',
      phoneNumber: phone,
      whatsappName: 'Tunde',
      pendingSend: {
        step: 'AWAITING_DISAMBIGUATION',
        ambiguousAmount: '50',
        recipient: null,
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
    const notify = async (to, text) => replies.push(text);

    await processMessage(phone, 'Tunde', 'no', {
      notify,
      prisma: fakeDb,
    });

    assert.equal(replies.length, 1);
    assert.ok(replies[0].includes('Payment cancelled'));
    assert.ok(!userState.pendingSend || typeof userState.pendingSend === 'symbol' || Object.keys(userState.pendingSend).length === 0);
  });
});
