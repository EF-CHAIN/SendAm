'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const StellarSdk = require('@stellar/stellar-sdk');

const userAccount = StellarSdk.Keypair.random().publicKey();
const transactionsDb = new Map();
const whatsappSentMessages = [];
const anchorTxStore = new Map();

const mockPrisma = {
  transaction: {
    create: async ({ data }) => {
      const id = `tx-local-${transactionsDb.size + 1}`;
      const record = {
        id,
        ...data,
        user: { id: data.userId, phoneNumber: data.recipientPhoneNumber || '+2348055556666' },
      };
      transactionsDb.set(id, record);
      return record;
    },
    findFirst: async ({ where }) => {
      for (const tx of transactionsDb.values()) {
        if (where.providerTransactionId && tx.providerTransactionId === where.providerTransactionId) {
          return tx;
        }
      }
      return null;
    },
    update: async ({ where, data }) => {
      const existing = transactionsDb.get(where.id);
      if (!existing) throw new Error('Transaction not found');
      Object.assign(existing, data);
      return existing;
    },
  },
};

const inject = (relative, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relative}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

inject('common/prisma', mockPrisma);
inject('common/audit.service', { writeAuditLog: async () => null });
inject('services/whatsapp.service', {
  sendTextMessage: async (to, body) => {
    const entry = { to, body, outcome: 'accepted', providerMessageId: `wamid-${whatsappSentMessages.length + 1}` };
    whatsappSentMessages.push(entry);
    return entry;
  },
});

const sep24Client = require('../src/services/sep24.client');
const sep24Routes = require('../src/routes/sep24.routes');

const createMockSep24AnchorApp = () => {
  const app = express();
  app.use(express.json());

  app.get('/info', (_req, res) => {
    res.status(200).json({
      deposit: {
        USDC: { enabled: true, min_amount: 1, max_amount: 10000 },
        NGNT: { enabled: true, min_amount: 500, max_amount: 5000000 },
      },
      withdraw: {
        USDC: { enabled: true, min_amount: 1, max_amount: 10000 },
      },
      fee: { enabled: false },
    });
  });

  const requireBearer = (req, res, next) => {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) {
      return res.status(403).json({ type: 'authentication_required' });
    }
    return next();
  };

  app.post('/transactions/deposit/interactive', requireBearer, (req, res) => {
    const { asset_code: assetCode, amount, account } = req.body || {};
    if (!assetCode) {
      return res.status(400).json({ error: 'asset_code is required' });
    }
    const id = `anchor-dep-${anchorTxStore.size + 1}`;
    const url = `https://anchor.test/sep24/interactive?operation=deposit&asset_code=${assetCode}&tx=${id}`;
    const tx = {
      id,
      kind: 'deposit',
      status: 'incomplete',
      asset_code: assetCode,
      amount_in: amount || null,
      to: account || null,
      more_info_url: url,
    };
    anchorTxStore.set(id, tx);
    return res.status(200).json({
      type: 'interactive_customer_info_needed',
      url,
      id,
    });
  });

  app.post('/transactions/withdraw/interactive', requireBearer, (req, res) => {
    const { asset_code: assetCode, amount, account } = req.body || {};
    if (!assetCode) {
      return res.status(400).json({ error: 'asset_code is required' });
    }
    const id = `anchor-wd-${anchorTxStore.size + 1}`;
    const url = `https://anchor.test/sep24/interactive?operation=withdraw&asset_code=${assetCode}&tx=${id}`;
    const tx = {
      id,
      kind: 'withdrawal',
      status: 'incomplete',
      asset_code: assetCode,
      amount_in: amount || null,
      from: account || null,
      more_info_url: url,
    };
    anchorTxStore.set(id, tx);
    return res.status(200).json({
      type: 'interactive_customer_info_needed',
      url,
      id,
    });
  });

  app.get('/transaction', requireBearer, (req, res) => {
    const tx = anchorTxStore.get(req.query.id);
    if (!tx) {
      return res.status(404).json({ error: 'transaction not found' });
    }
    return res.status(200).json({ transaction: tx });
  });

  return app;
};

const withTestServers = async (run) => {
  const anchorServer = http.createServer(createMockSep24AnchorApp());
  await new Promise((resolve) => anchorServer.listen(0, resolve));
  const anchorUrl = `http://127.0.0.1:${anchorServer.address().port}`;

  const apiApp = express();
  apiApp.use('/api/sep24', sep24Routes);
  const apiServer = http.createServer(apiApp);
  await new Promise((resolve) => apiServer.listen(0, resolve));
  const apiBaseUrl = `http://127.0.0.1:${apiServer.address().port}`;

  try {
    await run({ anchorUrl, apiBaseUrl });
  } finally {
    await new Promise((resolve) => apiServer.close(resolve));
    await new Promise((resolve) => anchorServer.close(resolve));
  }
};

beforeEach(() => {
  transactionsDb.clear();
  whatsappSentMessages.length = 0;
  anchorTxStore.clear();
  sep24Client.clearMemoryStores();
});

describe('SEP-24 Interactive Deposit and Withdrawal Flow (#945)', () => {
  test('end-to-end interactive deposit: initiates session, sends short URL via WhatsApp, redirects user to anchor webview, and processes anchor callback confirmation', async () => {
    await withTestServers(async ({ anchorUrl, apiBaseUrl }) => {
      // 1. Initiate interactive deposit via POST /api/sep24/deposit/interactive
      const initRes = await fetch(`${apiBaseUrl}/api/sep24/deposit/interactive`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer sep10-valid-jwt',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          transferServerUrl: anchorUrl,
          publicBaseUrl: apiBaseUrl,
          assetCode: 'USDC',
          amount: '150.00',
          account: userAccount,
          userId: 'user-sep24-1',
          phoneNumber: '+2348055556666',
        }),
      });

      assert.equal(initRes.status, 200);
      const initBody = await initRes.json();
      assert.equal(initBody.success, true);
      assert.equal(initBody.type, 'interactive_customer_info_needed');
      assert.equal(initBody.id, 'anchor-dep-1');
      assert.ok(initBody.shortUrl.startsWith(`${apiBaseUrl}/api/sep24/r/`));
      assert.ok(initBody.shortCode);

      // Verify WhatsApp message with short URL was sent to the user
      assert.equal(whatsappSentMessages.length, 1);
      assert.equal(whatsappSentMessages[0].to, '+2348055556666');
      assert.ok(whatsappSentMessages[0].body.includes(initBody.shortUrl));
      assert.ok(whatsappSentMessages[0].body.includes('150.00 USDC deposit'));

      // Verify pending Transaction was created in database
      const localTx = transactionsDb.get(initBody.data.transactionId);
      assert.ok(localTx);
      assert.equal(localTx.providerTransactionId, 'anchor-dep-1');
      assert.equal(localTx.status, 'pending');
      assert.equal(localTx.rail, 'sep24');

      // 2. User taps short URL in WhatsApp -> GET /api/sep24/r/:code redirects (302) to anchor interactive webview
      const redirectRes = await fetch(initBody.shortUrl, { redirect: 'manual' });
      assert.equal(redirectRes.status, 302);
      assert.equal(redirectRes.headers.get('location'), initBody.url);

      // 3. Anchor completes flow and posts transaction confirmation to POST /api/sep24/callback
      const callbackRes = await fetch(`${apiBaseUrl}/api/sep24/callback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          transaction: {
            id: 'anchor-dep-1',
            kind: 'deposit',
            status: 'completed',
            amount_in: '150.00',
            amount_out: '149.25',
            amount_fee: '0.75',
            asset_code: 'USDC',
            stellar_transaction_id: 'stellar-tx-hash-999',
            external_transaction_id: 'paystack-ref-100',
          },
        }),
      });

      assert.equal(callbackRes.status, 200);
      const callbackBody = await callbackRes.json();
      assert.equal(callbackBody.success, true);
      assert.equal(callbackBody.data.internalStatus, 'completed');
      assert.equal(callbackBody.data.stellarTransactionId, 'stellar-tx-hash-999');
      assert.equal(callbackBody.data.notified, true);

      // Verify local Transaction was updated to 'completed' with txHash
      const updatedTx = transactionsDb.get(localTx.id);
      assert.equal(updatedTx.status, 'completed');
      assert.equal(updatedTx.txHash, 'stellar-tx-hash-999');
      assert.equal(updatedTx.metadata.sep24.anchorStatus, 'completed');
      assert.equal(updatedTx.metadata.sep24.amountOut, '149.25');

      // Verify completion confirmation was sent to user on WhatsApp
      assert.equal(whatsappSentMessages.length, 2);
      assert.ok(whatsappSentMessages[1].body.includes('completed'));
      assert.ok(whatsappSentMessages[1].body.includes('anchor-dep-1'));
    });
  });

  test('end-to-end interactive withdrawal: initiates session, sends short link, and queries anchor info and transaction status', async () => {
    await withTestServers(async ({ anchorUrl, apiBaseUrl }) => {
      // Query GET /api/sep24/info
      const infoRes = await fetch(`${apiBaseUrl}/api/sep24/info?transferServerUrl=${encodeURIComponent(anchorUrl)}`);
      assert.equal(infoRes.status, 200);
      const infoBody = await infoRes.json();
      assert.equal(infoBody.data.withdraw.USDC.enabled, true);

      // Initiate interactive withdrawal
      const withdrawRes = await fetch(`${apiBaseUrl}/api/sep24/withdraw/interactive`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer sep10-valid-jwt',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          transferServerUrl: anchorUrl,
          publicBaseUrl: apiBaseUrl,
          assetCode: 'USDC',
          amount: '75.00',
          account: userAccount,
          userId: 'user-sep24-2',
          phoneNumber: '+2348077778888',
        }),
      });

      assert.equal(withdrawRes.status, 200);
      const withdrawBody = await withdrawRes.json();
      assert.equal(withdrawBody.id, 'anchor-wd-1');
      assert.equal(whatsappSentMessages.length, 1);
      assert.ok(whatsappSentMessages[0].body.includes('75.00 USDC withdrawal'));

      // Query transaction status via GET /api/sep24/transaction
      const txRes = await fetch(
        `${apiBaseUrl}/api/sep24/transaction?transferServerUrl=${encodeURIComponent(anchorUrl)}&id=anchor-wd-1`,
        { headers: { authorization: 'Bearer sep10-valid-jwt' } },
      );
      assert.equal(txRes.status, 200);
      const txBody = await txRes.json();
      assert.equal(txBody.transaction.id, 'anchor-wd-1');
      assert.equal(txBody.transaction.kind, 'withdrawal');
    });
  });

  test('handles expired or unknown short URLs, missing parameters, and malformed anchor callbacks safely', async () => {
    await withTestServers(async ({ anchorUrl, apiBaseUrl }) => {
      // Unknown short link returns 404
      const unknownRes = await fetch(`${apiBaseUrl}/api/sep24/r/nonexistent-code`);
      assert.equal(unknownRes.status, 404);

      // Missing assetCode returns 400
      const missingAssetRes = await fetch(`${apiBaseUrl}/api/sep24/deposit/interactive`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer sep10-valid-jwt',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ transferServerUrl: anchorUrl }),
      });
      assert.equal(missingAssetRes.status, 400);

      // Malformed callback without transaction id/status returns 400
      const badCallbackRes = await fetch(`${apiBaseUrl}/api/sep24/callback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ transaction: { id: 'only-id-no-status' } }),
      });
      assert.equal(badCallbackRes.status, 400);
    });
  });
});
