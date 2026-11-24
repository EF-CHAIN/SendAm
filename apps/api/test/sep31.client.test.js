'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { Keypair } = require('@stellar/stellar-sdk');

const sep31Client = require('../src/services/sep31.client');

const ANCHOR_RECEIVING_ACCOUNT = Keypair.random().publicKey();
const SENDER_ID = 'sep12-sender-1';
const RECEIVER_ID = 'sep12-receiver-1';

const anchorTxMap = new Map();
const callbackRegistrations = [];
let createMode = 'ok';
let infoOverride = null;

const createMockSep31AnchorApp = () => {
  const app = express();
  app.use(express.json());

  const requireBearer = (req, res, next) => {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'authentication required' });
    }
    return next();
  };

  app.get('/info', (_req, res) => {
    if (infoOverride) {
      return res.status(200).json(infoOverride);
    }
    return res.status(200).json({
      receive: {
        USDC: {
          enabled: true,
          quotes_supported: true,
          quotes_required: false,
          min_amount: 10,
          max_amount: 10000,
          fields: {
            transaction: {
              dest_bank_name: { description: 'Recipient bank' },
              dest_account_number: { description: 'Recipient bank account number' },
            },
          },
        },
      },
    });
  });

  app.post('/transactions', requireBearer, (req, res) => {
    if (createMode === 'tx_info_needed') {
      return res.status(400).json({
        error: 'transaction_info_needed',
        fields: { transaction: { routing_number: { description: 'Bank routing number' } } },
      });
    }
    if (createMode === 'customer_info_needed') {
      return res.status(400).json({
        error: 'customer_info_needed',
        type: 'sep31-receiver',
      });
    }
    if (createMode === 'bad_anchor_account') {
      return res.status(200).json({
        id: 'sep31-tx-bad',
        stellar_account_id: 'INVALID_STELLAR_KEY',
      });
    }

    const { amount, asset_code: assetCode, destination_asset: destinationAsset, quote_id: quoteId, sender_id: senderId, receiver_id: receiverId } = req.body || {};
    const id = `sep31-tx-${anchorTxMap.size + 1}`;
    const memoHex = crypto.createHash('sha256').update(id).digest('base64');

    const record = {
      id,
      status: 'pending_sender',
      amount_in: String(amount),
      amount_in_asset: `stellar:${assetCode}`,
      amount_out: '155000.00',
      amount_out_asset: destinationAsset || 'iso4217:NGN',
      quote_id: quoteId || null,
      sender_id: senderId || null,
      receiver_id: receiverId || null,
      stellar_account_id: ANCHOR_RECEIVING_ACCOUNT,
      stellar_memo_type: 'hash',
      stellar_memo: memoHex,
      pollCount: 0,
      lifecycle: ['pending_sender', 'pending_receiver', 'pending_external', 'completed'],
    };
    anchorTxMap.set(id, record);

    return res.status(201).json({
      id,
      stellar_account_id: ANCHOR_RECEIVING_ACCOUNT,
      stellar_memo_type: 'hash',
      stellar_memo: memoHex,
    });
  });

  app.get('/transactions/:id', requireBearer, (req, res) => {
    const record = anchorTxMap.get(req.params.id);
    if (!record) {
      return res.status(404).json({ error: 'transaction not found' });
    }
    if (record.autoAdvance && record.pollCount < record.lifecycle.length - 1) {
      record.pollCount += 1;
      record.status = record.lifecycle[record.pollCount];
    }
    return res.status(200).json({
      transaction: {
        id: record.id,
        status: record.status,
        amount_in: record.amount_in,
        amount_out: record.amount_out,
        stellar_account_id: record.stellar_account_id,
        stellar_memo_type: record.stellar_memo_type,
        stellar_memo: record.stellar_memo,
        external_transaction_id: record.status === 'completed' ? `bank-ref-${record.id}` : null,
        completed_at: record.status === 'completed' ? new Date().toISOString() : null,
      },
    });
  });

  app.patch('/transactions/:id', requireBearer, (req, res) => {
    const record = anchorTxMap.get(req.params.id);
    if (!record) return res.status(404).json({ error: 'transaction not found' });
    record.fields = req.body.fields;
    record.status = 'pending_receiver';
    return res.status(200).json({ id: record.id, status: record.status });
  });

  app.put('/transactions/:id/callback', requireBearer, (req, res) => {
    callbackRegistrations.push({ id: req.params.id, url: req.body.url });
    return res.status(204).end();
  });

  return app;
};

const withSep31Anchor = async (run) => {
  const server = http.createServer(createMockSep31AnchorApp());
  await new Promise((resolve) => server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

beforeEach(() => {
  anchorTxMap.clear();
  callbackRegistrations.length = 0;
  createMode = 'ok';
  infoOverride = null;
});

describe('SEP-31 Cross-Border Payment Rail Adapter (#947)', () => {
  test('completes full cross-border remittance lifecycle through SEP-31 anchor mock and persists DB record', async () => {
    await withSep31Anchor(async (baseUrl) => {
      const submittedPayments = [];
      const persistedTxs = new Map();

      const mockPrisma = {
        transaction: {
          create: async ({ data }) => {
            const row = { id: 'db-sep31-1', ...data };
            persistedTxs.set(row.id, row);
            return { ...row };
          },
          update: async ({ where, data }) => {
            const row = { ...persistedTxs.get(where.id), ...data };
            persistedTxs.set(where.id, row);
            return { ...row };
          },
        },
      };

      const result = await sep31Client.executeCrossBorderPayment(
        {
          directPaymentServerUrl: baseUrl,
          jwt: 'sep10-jwt-token',
          amount: '100',
          assetCode: 'USDC',
          destinationAsset: 'iso4217:NGN',
          quoteId: 'quote-sep38-1',
          senderId: SENDER_ID,
          receiverId: RECEIVER_ID,
          fields: {
            transaction: {
              dest_bank_name: 'Guaranty Trust Bank',
              dest_account_number: '0123456789',
            },
          },
          callbackUrl: 'https://api.sendam.test/webhook/sep31',
          userId: 'user-b2b-1',
          recipientPhoneNumber: '+2348012345678',
          waitForCompletion: true,
          pollIntervalMs: 1,
          maxPollAttempts: 10,
        },
        {
          submitPayment: async (payment) => {
            submittedPayments.push(payment);
            // Enable mock anchor automatic status progression once Stellar payment lands
            const anchorRecord = anchorTxMap.get('sep31-tx-1');
            anchorRecord.autoAdvance = true;
            return { txHash: 'stellar-sep31-hash-1', explorerUrl: 'https://stellar.expert/tx/stellar-sep31-hash-1' };
          },
          prisma: mockPrisma,
          writeAuditLog: async () => null,
        },
      );

      assert.equal(callbackRegistrations.length, 1);
      assert.equal(callbackRegistrations[0].url, 'https://api.sendam.test/webhook/sep31');

      assert.equal(submittedPayments.length, 1);
      assert.equal(submittedPayments[0].destination, ANCHOR_RECEIVING_ACCOUNT);
      assert.equal(submittedPayments[0].amount, '100');
      assert.equal(submittedPayments[0].asset, 'USDC');
      assert.equal(submittedPayments[0].memoType, 'hash');
      assert.match(submittedPayments[0].memo, /^[0-9a-f]{64}$/);

      assert.equal(result.finalStatus.status, 'completed');
      assert.equal(result.finalStatus.externalTransactionId, 'bank-ref-sep31-tx-1');
      assert.deepEqual(result.statusHistory, ['pending_receiver', 'pending_external', 'completed']);

      const dbRow = persistedTxs.get('db-sep31-1');
      assert.equal(dbRow.rail, 'sep31');
      assert.equal(dbRow.routeType, 'cross_border');
      assert.equal(dbRow.status, 'success');
      assert.equal(dbRow.txHash, 'stellar-sep31-hash-1');
    });
  });

  test('supports updating transaction info when anchor pauses on pending_transaction_info_update', async () => {
    await withSep31Anchor(async (baseUrl) => {
      const created = await sep31Client.createTransaction({
        directPaymentServerUrl: baseUrl,
        jwt: 'sep10-jwt',
        amount: '50',
        assetCode: 'USDC',
        senderId: SENDER_ID,
        receiverId: RECEIVER_ID,
      });

      anchorTxMap.get(created.id).status = 'pending_transaction_info_update';
      const pollPaused = await sep31Client.pollTransactionUntilSettled({
        directPaymentServerUrl: baseUrl,
        jwt: 'sep10-jwt',
        id: created.id,
        pollIntervalMs: 1,
        maxAttempts: 5,
      });
      assert.equal(pollPaused.transaction.status, 'pending_transaction_info_update');
      assert.equal(pollPaused.transaction.internalStatus, 'escalated');

      const updated = await sep31Client.updateTransaction({
        directPaymentServerUrl: baseUrl,
        jwt: 'sep10-jwt',
        id: created.id,
        fields: { transaction: { purpose_of_payment: 'invoice_settlement' } },
      });
      assert.equal(updated.status, 'pending_receiver');
    });
  });

  test('validates /info corridor rules and handles SEP-31 error responses', async () => {
    await withSep31Anchor(async (baseUrl) => {
      // Missing required transaction field caught locally via /info validation
      await assert.rejects(
        () => sep31Client.executeCrossBorderPayment(
          {
            directPaymentServerUrl: baseUrl,
            jwt: 'sep10-jwt',
            amount: '100',
            assetCode: 'USDC',
            fields: { transaction: {} },
          },
          { submitPayment: async () => ({ txHash: 'x' }) },
        ),
        { code: 'transaction_info_needed', statusCode: 400 },
      );

      // Amount below minimum
      await assert.rejects(
        () => sep31Client.executeCrossBorderPayment(
          {
            directPaymentServerUrl: baseUrl,
            jwt: 'sep10-jwt',
            amount: '2',
            assetCode: 'USDC',
            fields: { transaction: { dest_bank_name: 'GTB', dest_account_number: '123' } },
          },
          { submitPayment: async () => ({ txHash: 'x' }) },
        ),
        { code: 'amount_below_minimum' },
      );

      // quotes_required enforcement
      infoOverride = {
        receive: {
          USDC: { enabled: true, quotes_required: true, min_amount: 10, max_amount: 5000 },
        },
      };
      await assert.rejects(
        () => sep31Client.executeCrossBorderPayment(
          {
            directPaymentServerUrl: baseUrl,
            jwt: 'sep10-jwt',
            amount: '50',
            assetCode: 'USDC',
          },
          { submitPayment: async () => ({ txHash: 'x' }) },
        ),
        { code: 'quote_required' },
      );
      infoOverride = null;

      // Anchor 400 transaction_info_needed
      createMode = 'tx_info_needed';
      await assert.rejects(
        () => sep31Client.createTransaction({
          directPaymentServerUrl: baseUrl,
          jwt: 'sep10-jwt',
          amount: '50',
          assetCode: 'USDC',
        }),
        (err) => err.code === 'transaction_info_needed' && Boolean(err.fields?.transaction?.routing_number),
      );

      // Anchor 400 customer_info_needed
      createMode = 'customer_info_needed';
      await assert.rejects(
        () => sep31Client.createTransaction({
          directPaymentServerUrl: baseUrl,
          jwt: 'sep10-jwt',
          amount: '50',
          assetCode: 'USDC',
        }),
        (err) => err.code === 'customer_info_needed' && err.customerType === 'sep31-receiver',
      );

      // Invalid anchor stellar_account_id
      createMode = 'bad_anchor_account';
      await assert.rejects(
        () => sep31Client.createTransaction({
          directPaymentServerUrl: baseUrl,
          jwt: 'sep10-jwt',
          amount: '50',
          assetCode: 'USDC',
        }),
        { code: 'invalid_anchor_response', statusCode: 502 },
      );
    });
  });

  test('rejects missing JWT, invalid callback URLs, and poll timeouts', async () => {
    await withSep31Anchor(async (baseUrl) => {
      await assert.rejects(
        () => sep31Client.createTransaction({
          directPaymentServerUrl: baseUrl,
          amount: '50',
          assetCode: 'USDC',
        }),
        { code: 'missing_sep10_jwt', statusCode: 401 },
      );

      await assert.rejects(
        () => sep31Client.registerCallback({
          directPaymentServerUrl: baseUrl,
          jwt: 'sep10-jwt',
          id: 'tx-1',
          callbackUrl: 'not-a-url',
        }),
        { code: 'invalid_parameter', statusCode: 400 },
      );

      const created = await sep31Client.createTransaction({
        directPaymentServerUrl: baseUrl,
        jwt: 'sep10-jwt',
        amount: '50',
        assetCode: 'USDC',
      });

      await assert.rejects(
        () => sep31Client.pollTransactionUntilSettled({
          directPaymentServerUrl: baseUrl,
          jwt: 'sep10-jwt',
          id: created.id,
          pollIntervalMs: 1,
          maxAttempts: 2,
        }),
        { code: 'sep31_poll_timeout', statusCode: 504 },
      );
    });
  });
});
