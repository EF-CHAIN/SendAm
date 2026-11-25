'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { Keypair } = require('@stellar/stellar-sdk');

const quoteStore = new Map();
const txStore = new Map();
const auditLogs = [];
const stellarSubmissions = [];

const inject = (relativeFromSrc, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relativeFromSrc}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

const makePrismaMock = () => ({
  $transaction: async (fn) => fn(makePrismaMock()),
  quote: {
    create: async ({ data }) => {
      if (data.idempotencyKey) {
        for (const existing of quoteStore.values()) {
          if (existing.idempotencyKey === data.idempotencyKey) {
            const err = new Error('Unique constraint');
            err.code = 'P2002';
            err.meta = { target: ['idempotencyKey'] };
            throw err;
          }
        }
      }
      const row = { id: `q_${quoteStore.size + 1}`, ...data, createdAt: new Date(), updatedAt: new Date() };
      quoteStore.set(row.id, row);
      return { ...row };
    },
    findUnique: async ({ where }) => {
      const q = quoteStore.get(where.id);
      return q ? { ...q } : null;
    },
    findFirst: async ({ where }) => {
      for (const q of quoteStore.values()) {
        if (where?.idempotencyKey && q.idempotencyKey === where.idempotencyKey) return { ...q };
      }
      return null;
    },
    update: async ({ where, data }) => {
      const q = quoteStore.get(where.id);
      if (!q) throw new Error('Quote not found');
      const updated = { ...q, ...data, updatedAt: new Date() };
      quoteStore.set(where.id, updated);
      return { ...updated };
    },
    updateMany: async ({ where, data }) => {
      const q = quoteStore.get(where.id);
      if (!q) return { count: 0 };
      if (where.status && q.status !== where.status) return { count: 0 };
      if (where.expiresAt?.gt && new Date(q.expiresAt) <= new Date(where.expiresAt.gt)) return { count: 0 };
      quoteStore.set(where.id, { ...q, ...data, updatedAt: new Date() });
      return { count: 1 };
    },
  },
  transaction: {
    create: async ({ data }) => {
      const row = { id: data.id || `tx_${txStore.size + 1}`, ...data, createdAt: new Date(), updatedAt: new Date() };
      txStore.set(row.id, row);
      return { ...row };
    },
    findUnique: async ({ where }) => {
      const tx = txStore.get(where.id)
        || Array.from(txStore.values()).find((item) => where.idempotencyKey && item.idempotencyKey === where.idempotencyKey);
      return tx ? { ...tx } : null;
    },
    update: async ({ where, data }) => {
      const tx = txStore.get(where.id);
      if (!tx) throw new Error('Transaction not found');
      const updated = { ...tx, ...data, updatedAt: new Date() };
      txStore.set(where.id, updated);
      return { ...updated };
    },
    updateMany: async ({ where, data }) => {
      const tx = txStore.get(where.id);
      if (!tx) return { count: 0 };
      if (where.status?.in && !where.status.in.includes(tx.status)) return { count: 0 };
      txStore.set(where.id, { ...tx, ...data, updatedAt: new Date() });
      return { count: 1 };
    },
  },
});

const prismaMock = makePrismaMock();

inject('common/prisma', prismaMock);
inject('common/audit.service', {
  writeAuditLog: async (entry) => {
    auditLogs.push(entry);
    return entry;
  },
});
inject('compliance/sanctionsScreening', { screenPaymentParties: async () => {} });
inject('compliance/riskEngine', {
  evaluateTransactionRisk: async () => ({ score: 0, reasons: [] }),
  assertRiskAllowsPayment: () => {},
});
inject('compliance/velocityLimits', {
  enforceVelocityLimit: async () => ({ enforced: false }),
  releaseVelocityReservation: async () => {},
});
inject('common/event.service', {
  EVENT_TYPES: { PAYMENT_SUBMITTED: 'payment.submitted' },
  appendEvent: async () => null,
});
inject('compliance/compliance.service', {
  enforceTransactionPolicy: async () => ({
    riskScore: 5,
    profile: { tier: 0 },
    policySnapshot: { convertedAmount: '155000.00', referenceCurrency: 'NGN' },
  }),
});
inject('compliance/account.service', {
  assertAccountActive: () => true,
});
inject('wallet/wallet.service', {
  createOrGetWallet: async ({ user }) => ({ id: `w_${user.id}`, publicKey: Keypair.random().publicKey(), encryptedSecretKey: 'enc' }),
  submitPayment: async (args) => {
    stellarSubmissions.push(args);
    return { txHash: 'stellar-sep38-tx-hash', explorerUrl: 'https://stellar.expert/tx/stellar-sep38-tx-hash' };
  },
});
inject('payment/ledger.service', {
  postPaymentSettled: async () => null,
  postPaymentFailed: async () => null,
});

const config = require('../src/config/env');
const { TESTNET_USDC_ISSUER } = require('../src/config/networkProfiles');
const quoteService = require('../src/pricing/quote.service');
const { executePayment } = require('../src/payment/payment.orchestrator');
const pricingRoutes = require('../src/pricing/pricing.routes');

const DEST = Keypair.random().publicKey();
let anchorQuoteTtlMs = 120000;

const createMockSep38AnchorApp = () => {
  const app = express();
  app.use(express.json());

  app.get('/price', (req, res) => {
    res.status(200).json({
      total_price: '1550.00',
      price: '1545.00',
      sell_amount: req.query.sell_amount || '100.0000000',
      buy_amount: '155000.00',
      fee: { total: '0.50', asset: req.query.sell_asset },
    });
  });

  app.post('/quote', (req, res) => {
    const expiresAt = new Date(Date.now() + anchorQuoteTtlMs).toISOString();
    res.status(201).json({
      id: `anchor-firm-${quoteStore.size + 1}`,
      expires_at: expiresAt,
      total_price: '1550.00',
      price: '1545.00',
      sell_asset: req.body.sell_asset,
      sell_amount: req.body.sell_amount || '100.0000000',
      buy_asset: req.body.buy_asset,
      buy_amount: '155000.00',
      fee: { total: '0.50', asset: req.body.sell_asset },
    });
  });

  return app;
};

const withServers = async (run) => {
  const anchorServer = http.createServer(createMockSep38AnchorApp());
  await new Promise((resolve) => anchorServer.listen(0, resolve));
  const anchorUrl = `http://127.0.0.1:${anchorServer.address().port}`;

  const apiApp = express();
  apiApp.use(express.json());
  apiApp.use('/api/pricing', pricingRoutes);
  apiApp.use((err, _req, res, _next) => {
    res.status(err.statusCode || 400).json({ success: false, message: err.message, code: err.code });
  });
  const apiServer = http.createServer(apiApp);
  await new Promise((resolve) => apiServer.listen(0, resolve));
  const apiUrl = `http://127.0.0.1:${apiServer.address().port}`;

  try {
    await run({ anchorUrl, apiUrl });
  } finally {
    await new Promise((resolve) => apiServer.close(resolve));
    await new Promise((resolve) => anchorServer.close(resolve));
  }
};

beforeEach(() => {
  quoteStore.clear();
  txStore.clear();
  auditLogs.length = 0;
  stellarSubmissions.length = 0;
  anchorQuoteTtlMs = 120000;
  config.pricing.exchangeRateApiKey = null;
});

describe('Firm Quote Engine and Payment Orchestrator Integration (#948)', () => {
  test('locks guaranteed SEP-38 firm quote for 60 seconds and executes trade through payment orchestrator within window', async () => {
    await withServers(async ({ anchorUrl }) => {
      const now = new Date();
      const sender = { id: 'user_sep38_1', phoneNumber: '+2348012345678' };

      const quote = await quoteService.createFirmCorridorQuote({
        userId: sender.id,
        sourceCurrency: 'USDC',
        targetCurrency: 'NGN',
        sourceAmount: '100.0000000',
        quoteServerUrl: anchorUrl,
        jwt: 'sep10-jwt',
        idempotencyKey: 'firm-quote-idem-1',
        now,
      });

      assert.equal(quote.provider, 'sep38');
      assert.equal(quote.firm, true);
      assert.equal(quote.status, 'active');
      assert.equal(quote.sourceCurrency, 'USDC');
      assert.equal(quote.targetCurrency, 'NGN');
      assert.equal(quote.targetAmount, '155000.00');
      assert.equal(quote.expiresAt.getTime() - now.getTime(), 60000);

      // Idempotent retry returns the existing locked quote
      const duplicateQuote = await quoteService.createFirmCorridorQuote({
        userId: sender.id,
        sourceCurrency: 'USDC',
        targetCurrency: 'NGN',
        sourceAmount: '100.0000000',
        quoteServerUrl: anchorUrl,
        jwt: 'sep10-jwt',
        idempotencyKey: 'firm-quote-idem-1',
        now,
      });
      assert.equal(duplicateQuote.id, quote.id);

      // Orchestrator settles payment using the guaranteed SEP-38 firm quote within validity window
      const paymentResult = await executePayment({
        sender,
        destination: DEST,
        amount: '100',
        asset: 'USDC',
        targetCurrency: 'NGN',
        quoteId: quote.id,
      });

      assert.equal(paymentResult.transaction.status, 'pending');
      assert.equal(paymentResult.transaction.quoteId, quote.id);
      assert.equal(paymentResult.transaction.fiatCurrency, 'NGN');
      assert.equal(paymentResult.transaction.fiatAmount, '155000.00');
      assert.equal(paymentResult.transaction.metadata.sep38Quote.anchorQuoteId, quote.anchorQuoteId);
      assert.equal(stellarSubmissions.length, 1);

      const consumedQuote = quoteStore.get(quote.id);
      assert.equal(consumedQuote.status, 'consumed');

      // Reusing consumed quote is rejected
      await assert.rejects(
        () => executePayment({
          sender,
          destination: DEST,
          amount: '100',
          asset: 'USDC',
          targetCurrency: 'NGN',
          quoteId: quote.id,
        }),
        { code: 'QUOTE_NOT_ACTIVE' },
      );
    });
  });

  test('rejects firm quote execution once 60-second validity window expires and creates zero transactions', async () => {
    await withServers(async ({ anchorUrl }) => {
      const sender = { id: 'user_sep38_exp', phoneNumber: '+2348099990000' };
      const past = new Date(Date.now() - 61000);

      const expiredQuote = await quoteService.createFirmCorridorQuote({
        userId: sender.id,
        sourceCurrency: 'USDC',
        targetCurrency: 'NGN',
        sourceAmount: '50.0000000',
        quoteServerUrl: anchorUrl,
        jwt: 'sep10-jwt',
        now: past,
      });

      assert.ok(expiredQuote.expiresAt.getTime() < Date.now());

      await assert.rejects(
        () => executePayment({
          sender,
          destination: DEST,
          amount: '50',
          asset: 'USDC',
          targetCurrency: 'NGN',
          quoteId: expiredQuote.id,
        }),
        { code: 'QUOTE_EXPIRED' },
      );

      assert.equal(txStore.size, 0);
      assert.equal(stellarSubmissions.length, 0);
    });
  });

  test('enforces ownership, asset pair, and amount checks on firm quotes', async () => {
    await withServers(async ({ anchorUrl }) => {
      const owner = { id: 'user_owner' };
      const quote = await quoteService.createFirmCorridorQuote({
        userId: owner.id,
        sourceCurrency: 'USDC',
        targetCurrency: 'NGN',
        sourceAmount: '25.0000000',
        quoteServerUrl: anchorUrl,
        jwt: 'sep10-jwt',
      });

      assert.throws(
        () => quoteService.assertFirmQuoteValidForExecution({
          quote,
          userId: 'other_user',
          sourceAsset: 'USDC',
          targetAsset: 'NGN',
          amount: '25',
        }),
        { code: 'QUOTE_OWNERSHIP' },
      );

      assert.throws(
        () => quoteService.assertFirmQuoteValidForExecution({
          quote,
          userId: owner.id,
          sourceAsset: 'XLM',
          targetAsset: 'NGN',
          amount: '25',
        }),
        { code: 'QUOTE_ASSET_PAIR' },
      );

      assert.throws(
        () => quoteService.assertFirmQuoteValidForExecution({
          quote,
          userId: owner.id,
          sourceAsset: 'USDC',
          targetAsset: 'NGN',
          amount: '30',
        }),
        { code: 'QUOTE_AMOUNT' },
      );
    });
  });

  test('clamps firm quote expiration if anchor provides shorter TTL and serves pricing HTTP routes', async () => {
    await withServers(async ({ anchorUrl, apiUrl }) => {
      anchorQuoteTtlMs = 25000;
      const clamped = await quoteService.createFirmCorridorQuote({
        userId: 'user_clamp',
        sourceCurrency: 'USDC',
        targetCurrency: 'NGN',
        sourceAmount: '10',
        quoteServerUrl: anchorUrl,
        jwt: 'sep10-jwt',
      });
      assert.ok(clamped.remainingMs > 0 && clamped.remainingMs < 30000);
      assert.equal(
        clamped.expiresAt.getTime(),
        new Date(clamped.metadata.sep38.anchorExpiresAt).getTime(),
      );

      const windowInfo = await quoteService.getQuoteWithRemainingWindow({
        quoteId: clamped.id,
        prismaClient: prismaMock,
      });
      assert.equal(windowInfo.isExecutable, true);
      assert.equal(windowInfo.isExpired, false);

      const consumed = await quoteService.consumeFirmQuote({
        quoteId: clamped.id,
        userId: 'user_clamp',
        sourceAsset: 'USDC',
        targetAsset: 'NGN',
        amount: '10',
        tx: prismaMock,
      });
      assert.equal(consumed.quote.status, 'consumed');

      anchorQuoteTtlMs = 120000;
      const pricesRes = await fetch(
        `${apiUrl}/api/pricing/sep38/prices?quoteServerUrl=${encodeURIComponent(anchorUrl)}&sourceCurrency=USDC&targetCurrency=NGN&sourceAmount=100`,
      );
      assert.equal(pricesRes.status, 200);
      const pricesJson = await pricesRes.json();
      assert.equal(pricesJson.data.buyAsset, 'iso4217:NGN');

      const quoteRes = await fetch(`${apiUrl}/api/pricing/sep38/quote`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer sep10-jwt',
        },
        body: JSON.stringify({
          userId: 'user_http_1',
          quoteServerUrl: anchorUrl,
          sellAsset: `stellar:USDC:${TESTNET_USDC_ISSUER}`,
          buyAsset: 'iso4217:NGN',
          sellAmount: '100.0000000',
          context: 'sep31',
        }),
      });
      assert.equal(quoteRes.status, 201);
      const quoteJson = await quoteRes.json();
      assert.equal(quoteJson.data.firm, true);
      assert.equal(quoteJson.data.provider, 'sep38');
      assert.equal(quoteJson.data.lockDurationSeconds, 60);
    });
  });
});
