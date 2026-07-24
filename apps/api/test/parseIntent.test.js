const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/sendam';

const { parsePaymentIntent } = require('../src/whatsapp/assistant.service');

const paymentIntents = [
  {
    input: 'send 5 xlm ada',
    expected: { amount: '5', asset: 'XLM', recipient: 'ada' },
  },
  {
    input: 'pay 10 to +2348000000000',
    expected: { amount: '10', asset: undefined, recipient: '+2348000000000' },
  },
  {
    input: 'transfer 2.5 usdc GABC123',
    expected: { amount: '2.5', asset: 'USDC', recipient: 'GABC123' },
  },
  {
    input: 'send 5 ada',
    expected: { amount: '5', asset: undefined, recipient: 'ada' },
  },
  {
    input: '  send   0.125   xlm   to   GDESTINATION  ',
    expected: { amount: '0.125', asset: 'XLM', recipient: 'GDESTINATION' },
  },
];

for (const { input, expected } of paymentIntents) {
  test(`parsePaymentIntent parses "${input.trim()}"`, () => {
    assert.deepEqual(parsePaymentIntent(input), expected);
  });
}

for (const input of ['hello', 'balance', '']) {
  test(`parsePaymentIntent rejects non-command "${input}"`, () => {
    assert.equal(parsePaymentIntent(input), null);
  });
}
