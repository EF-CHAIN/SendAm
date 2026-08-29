const { test } = require('node:test');
const assert = require('node:assert/strict');
const ledger = require('../src/payment/ledger.service');

test('assertBalancedPostings accepts entries that sum to zero per asset', () => {
  assert.equal(ledger.assertBalancedPostings([
    { asset: 'XLM', amount: '-101.0000000' },
    { asset: 'XLM', amount: '100.0000000' },
    { asset: 'XLM', amount: '1.0000000' },
  ]), true);
});

test('assertBalancedPostings rejects unbalanced entries', () => {
  assert.throws(() => ledger.assertBalancedPostings([
    { asset: 'USDC', amount: '-10.0000000' },
    { asset: 'USDC', amount: '9.9900000' },
  ]), /unbalanced/);
});

test('postPaymentReserved writes immutable journal-shaped records through the transaction client', async () => {
  const createdAccounts = [];
  const createdEntries = [];
  const tx = {
    ledgerAccount: {
      findUnique: async () => null,
      create: async ({ data }) => {
        const account = { id: `acct_${createdAccounts.length + 1}`, ...data };
        createdAccounts.push(account);
        return account;
      },
    },
    ledgerPosting: {},
    journalEntry: {
      create: async ({ data }) => {
        createdEntries.push(data);
        return { id: 'entry_1', ...data, postings: data.postings.create };
      },
    },
  };

  const entry = await ledger.postPaymentReserved({
    tx,
    transaction: {
      id: 'tx_1',
      userId: 'user_1',
      amount: '100.0000000',
      asset: 'XLM',
      status: 'processing',
      quoteId: 'quote_1',
      metadata: { fee: '1.0000000' },
    },
  });

  assert.equal(entry.eventType, 'payment.reserved');
  assert.equal(createdAccounts.length, 3);
  assert.equal(createdEntries[0].postings.create.length, 3);
});
