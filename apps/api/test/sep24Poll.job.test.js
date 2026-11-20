'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');

const transactionsStore = new Map();
const notificationsSent = [];
const auditLogs = [];
const workflowEvents = [];

const inject = (relativeFromSrc, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relativeFromSrc}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

const mockPrisma = {
  transaction: {
    findMany: async ({ where }) => {
      const results = [];
      for (const tx of transactionsStore.values()) {
        if (where?.rail && tx.rail !== where.rail) continue;
        if (where?.status?.in && !where.status.in.includes(tx.status)) continue;
        results.push({ ...tx });
      }
      return results;
    },
    findFirst: async ({ where }) => {
      for (const tx of transactionsStore.values()) {
        if (where?.providerTransactionId && tx.providerTransactionId === where.providerTransactionId) {
          return { ...tx };
        }
      }
      return null;
    },
    findUnique: async ({ where }) => {
      const tx = transactionsStore.get(where?.id);
      return tx ? { ...tx } : null;
    },
    update: async ({ where, data }) => {
      const existing = transactionsStore.get(where.id);
      if (!existing) throw new Error(`Transaction not found: ${where.id}`);
      const updated = {
        ...existing,
        ...data,
        metadata: data.metadata ? { ...data.metadata } : existing.metadata,
        updatedAt: new Date(),
      };
      transactionsStore.set(where.id, updated);
      return { ...updated };
    },
  },
};

inject('common/prisma', mockPrisma);
inject('services/whatsapp.service', {
  sendTextMessage: async (to, body, options) => {
    notificationsSent.push({ to, body, options });
    return { outcome: 'accepted', providerMessageId: `wamid-${notificationsSent.length}` };
  },
});
inject('common/audit.service', {
  writeAuditLog: async (entry) => {
    auditLogs.push(entry);
    return entry;
  },
});
inject('common/event.service', {
  appendEvent: async (entry) => {
    workflowEvents.push(entry);
    return entry;
  },
});
inject('middlewares/verifyWhatsappSignature', (_req, _res, next) => next());
inject('common/validation', { validateExternalPayload: () => (_req, _res, next) => next() });
inject('controllers/webhook.controller', { handleIncomingMessage: (_req, res) => res.sendStatus(200) });

const config = require('../src/config/env');
const sep24PollJob = require('../src/jobs/sep24Poll.job');
const webhookRoutes = require('../src/routes/webhook.routes');

const anchorTxStates = new Map();
let failingAnchorId = null;

const createMockSep24AnchorApp = () => {
  const app = express();
  app.get('/transaction', (req, res) => {
    const id = req.query.id;
    if (id && id === failingAnchorId) {
      return res.status(500).json({ error: 'anchor temporary failure' });
    }
    const tx = anchorTxStates.get(id);
    if (!tx) {
      return res.status(404).json({ error: 'not found' });
    }
    return res.status(200).json({ transaction: tx });
  });
  return app;
};

const withAnchorAndWebhookServers = async (run) => {
  const anchorServer = http.createServer(createMockSep24AnchorApp());
  await new Promise((resolve) => anchorServer.listen(0, resolve));
  const anchorUrl = `http://127.0.0.1:${anchorServer.address().port}`;

  const apiApp = express();
  apiApp.use('/webhook', webhookRoutes);
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

const signPayload = (bodyString, secret) =>
  `sha256=${crypto.createHmac('sha256', secret).update(bodyString).digest('hex')}`;

beforeEach(() => {
  transactionsStore.clear();
  notificationsSent.length = 0;
  auditLogs.length = 0;
  workflowEvents.length = 0;
  anchorTxStates.clear();
  failingAnchorId = null;
  config.stellar.anchorWebhookSecret = null;
});

describe('SEP-24 Status Polling and Webhook Handlers (#946)', () => {
  test('tracks full SEP-24 lifecycle transitions across sweeps and sends WhatsApp progress and completion alerts', async () => {
    await withAnchorAndWebhookServers(async ({ anchorUrl }) => {
      transactionsStore.set('tx-1', {
        id: 'tx-1',
        userId: 'user-1',
        type: 'deposit',
        amount: '100',
        asset: 'USDC',
        rail: 'sep24',
        status: 'pending',
        providerTransactionId: 'anchor-tx-1',
        recipientPhoneNumber: '+2348011112222',
        user: { id: 'user-1', phoneNumber: '+2348011112222' },
        metadata: {
          sep24: {
            anchorTransactionId: 'anchor-tx-1',
            anchorStatus: 'incomplete',
            kind: 'deposit',
            assetCode: 'USDC',
            transferServerUrl: anchorUrl,
            jwt: 'sep10-jwt-token',
          },
        },
      });

      const sequence = [
        { status: 'pending_user_transfer_start', expectedInternal: 'pending', expectedNotify: true },
        { status: 'pending_user_transfer_start', expectedInternal: 'pending', expectedNotify: false }, // duplicate check
        { status: 'pending_user_transfer_complete', expectedInternal: 'processing', expectedNotify: true },
        { status: 'pending_anchor', expectedInternal: 'processing', expectedNotify: true },
        { status: 'pending_stellar', expectedInternal: 'processing', expectedNotify: true },
        {
          status: 'completed',
          expectedInternal: 'success',
          expectedNotify: true,
          stellar_transaction_id: 'stellar-tx-abc123',
          amount_out: '99.50',
        },
      ];

      for (const step of sequence) {
        anchorTxStates.set('anchor-tx-1', {
          id: 'anchor-tx-1',
          kind: 'deposit',
          status: step.status,
          asset_code: 'USDC',
          amount_in: '100',
          amount_out: step.amount_out || null,
          stellar_transaction_id: step.stellar_transaction_id || null,
        });

        const notifyCountBefore = notificationsSent.length;
        const sweep = await sep24PollJob.runSep24PollSweep({ prismaClient: mockPrisma });
        assert.equal(sweep.ok, true);

        const current = transactionsStore.get('tx-1');
        assert.equal(current.status, step.expectedInternal);
        assert.equal(current.metadata.sep24.anchorStatus, step.status);

        if (step.expectedNotify) {
          assert.equal(notificationsSent.length, notifyCountBefore + 1);
          assert.equal(notificationsSent[notificationsSent.length - 1].to, '+2348011112222');
        } else {
          assert.equal(notificationsSent.length, notifyCountBefore);
        }
      }

      const finalTx = transactionsStore.get('tx-1');
      assert.equal(finalTx.status, 'success');
      assert.equal(finalTx.txHash, 'stellar-tx-abc123');
      assert.equal(finalTx.metadata.sep24.statusHistory.length, 5);
      assert.match(notificationsSent[notificationsSent.length - 1].body, /completed/);
      assert.match(notificationsSent[notificationsSent.length - 1].body, /stellar-tx-abc123/);

      // Terminal transactions are no longer queried as active on subsequent sweeps
      const postSweep = await sep24PollJob.runSep24PollSweep({ prismaClient: mockPrisma });
      assert.equal(postSweep.polled, 0);
    });
  });

  test('triggers customer alerts for terminal error, refunded, and expired states and prevents terminal regression', async () => {
    const terminalCases = [
      { id: 'tx-err', anchorId: 'anc-err', status: 'error', internal: 'failed', msg: 'Invalid bank account', match: /failed.*Invalid bank account/ },
      { id: 'tx-ref', anchorId: 'anc-ref', status: 'refunded', internal: 'reversed', msg: 'Returned to wallet', match: /refunded/ },
      { id: 'tx-exp', anchorId: 'anc-exp', status: 'expired', internal: 'expired', msg: null, match: /expired/ },
    ];

    for (const tc of terminalCases) {
      transactionsStore.set(tc.id, {
        id: tc.id,
        userId: 'user-2',
        type: 'withdrawal',
        amount: '50',
        asset: 'USDC',
        rail: 'sep24',
        status: 'processing',
        providerTransactionId: tc.anchorId,
        recipientPhoneNumber: '+2348099998888',
        metadata: {
          sep24: {
            anchorTransactionId: tc.anchorId,
            anchorStatus: 'pending_anchor',
            kind: 'withdrawal',
            assetCode: 'USDC',
          },
        },
      });

      const res = await sep24PollJob.applySep24StatusUpdate({
        transaction: transactionsStore.get(tc.id),
        anchorTransaction: {
          id: tc.anchorId,
          kind: 'withdrawal',
          status: tc.status,
          message: tc.msg,
        },
        source: 'poll',
      });

      assert.equal(res.updated, true);
      assert.equal(res.terminal, true);
      assert.equal(res.internalStatus, tc.internal);
      assert.equal(res.notified, true);
      assert.match(notificationsSent[notificationsSent.length - 1].body, tc.match);
    }

    // Attempt regression from terminal 'error' back to 'pending_anchor'
    const regressed = await sep24PollJob.applySep24StatusUpdate({
      transaction: transactionsStore.get('tx-err'),
      anchorTransaction: { id: 'anc-err', status: 'pending_anchor' },
      source: 'webhook',
    });
    assert.equal(regressed.updated, false);
    assert.equal(regressed.ignoredTerminal, true);
    assert.equal(transactionsStore.get('tx-err').status, 'failed');
  });

  test('isolates per-transaction polling failures and survives WhatsApp notification failures', async () => {
    await withAnchorAndWebhookServers(async ({ anchorUrl }) => {
      failingAnchorId = 'anchor-fail';

      transactionsStore.set('tx-fail', {
        id: 'tx-fail',
        userId: 'user-1',
        type: 'deposit',
        amount: '10',
        asset: 'USDC',
        rail: 'sep24',
        status: 'pending',
        providerTransactionId: 'anchor-fail',
        recipientPhoneNumber: '+2348011111111',
        metadata: {
          sep24: { anchorTransactionId: 'anchor-fail', anchorStatus: 'incomplete', transferServerUrl: anchorUrl },
        },
      });

      transactionsStore.set('tx-ok', {
        id: 'tx-ok',
        userId: 'user-2',
        type: 'deposit',
        amount: '25',
        asset: 'USDC',
        rail: 'sep24',
        status: 'pending',
        providerTransactionId: 'anchor-ok',
        recipientPhoneNumber: '+2348022222222',
        metadata: {
          sep24: { anchorTransactionId: 'anchor-ok', anchorStatus: 'incomplete', transferServerUrl: anchorUrl },
        },
      });

      anchorTxStates.set('anchor-ok', {
        id: 'anchor-ok',
        kind: 'deposit',
        status: 'completed',
        asset_code: 'USDC',
        amount_in: '25',
      });

      const sweep = await sep24PollJob.runSep24PollSweep({
        prismaClient: mockPrisma,
        notify: async () => {
          throw new Error('WhatsApp Meta API down');
        },
      });

      assert.equal(sweep.polled, 2);
      assert.equal(sweep.errors, 1);
      assert.equal(sweep.updated, 1);
      assert.equal(transactionsStore.get('tx-ok').status, 'success');
      assert.equal(transactionsStore.get('tx-ok').metadata.sep24.lastNotificationError, 'WhatsApp Meta API down');
    });
  });

  test('processes signed SEP-24 webhook callbacks via Express route and rejects invalid signatures or malformed payloads', async () => {
    await withAnchorAndWebhookServers(async ({ apiUrl }) => {
      const secret = 'super-secret-anchor-hmac-key';
      config.stellar.anchorWebhookSecret = secret;

      transactionsStore.set('tx-wh-1', {
        id: 'tx-wh-1',
        userId: 'user-wh',
        type: 'deposit',
        amount: '200',
        asset: 'USDC',
        rail: 'sep24',
        status: 'pending',
        providerTransactionId: 'anchor-wh-1',
        recipientPhoneNumber: '+2348077776666',
        metadata: {
          sep24: {
            anchorTransactionId: 'anchor-wh-1',
            anchorStatus: 'pending_user_transfer_start',
            kind: 'deposit',
            assetCode: 'USDC',
          },
        },
      });

      const validPayload = JSON.stringify({
        transaction: {
          id: 'anchor-wh-1',
          kind: 'deposit',
          status: 'completed',
          asset_code: 'USDC',
          amount_out: '198.00',
          stellar_transaction_id: 'stellar-wh-hash',
        },
      });

      // Missing signature -> 401
      const noSigRes = await fetch(`${apiUrl}/webhook/sep24`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: validPayload,
      });
      assert.equal(noSigRes.status, 401);

      // Invalid signature -> 401
      const badSigRes = await fetch(`${apiUrl}/webhook/sep24`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-sep24-signature': 'sha256=deadbeef',
        },
        body: validPayload,
      });
      assert.equal(badSigRes.status, 401);

      // Malformed payload -> 400
      const malformedPayload = JSON.stringify({ transaction: { id: 'anchor-wh-1', status: 'not_a_sep24_status' } });
      const malformedRes = await fetch(`${apiUrl}/webhook/sep24`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-sep24-signature': signPayload(malformedPayload, secret),
        },
        body: malformedPayload,
      });
      assert.equal(malformedRes.status, 400);

      // Valid signed webhook -> 200, updates DB + notifies
      const okRes = await fetch(`${apiUrl}/webhook/sep24`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-sep24-signature': signPayload(validPayload, secret),
        },
        body: validPayload,
      });
      assert.equal(okRes.status, 200);
      const okBody = await okRes.json();
      assert.equal(okBody.data.updated, true);
      assert.equal(okBody.data.internalStatus, 'success');
      assert.equal(okBody.data.notified, true);
      assert.equal(transactionsStore.get('tx-wh-1').status, 'success');
      assert.equal(transactionsStore.get('tx-wh-1').txHash, 'stellar-wh-hash');

      // Unmatched anchor transaction -> 200 unmatched
      const unmatchedPayload = JSON.stringify({ id: 'unknown-anchor-tx', status: 'pending_anchor' });
      const unmatchedRes = await fetch(`${apiUrl}/webhook/sep24`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-sep24-signature': signPayload(unmatchedPayload, secret),
        },
        body: unmatchedPayload,
      });
      assert.equal(unmatchedRes.status, 200);
      const unmatchedBody = await unmatchedRes.json();
      assert.equal(unmatchedBody.data.unmatched, true);
    });
  });

  test('startSep24Poller runs sweeps and guards overlapping invocations', async () => {
    await withAnchorAndWebhookServers(async ({ anchorUrl }) => {
      transactionsStore.set('tx-poll', {
        id: 'tx-poll',
        userId: 'user-p',
        type: 'deposit',
        amount: '30',
        asset: 'USDC',
        rail: 'sep24',
        status: 'pending',
        providerTransactionId: 'anchor-poll-1',
        recipientPhoneNumber: '+2348055554444',
        metadata: {
          sep24: { anchorTransactionId: 'anchor-poll-1', anchorStatus: 'incomplete', transferServerUrl: anchorUrl },
        },
      });
      anchorTxStates.set('anchor-poll-1', {
        id: 'anchor-poll-1',
        kind: 'deposit',
        status: 'pending_anchor',
      });

      const poller = sep24PollJob.startSep24Poller({
        intervalMs: 60000,
        prismaClient: mockPrisma,
        runImmediately: false,
      });

      try {
        const res = await poller.runOnce();
        assert.equal(res.updated, 1);
        assert.equal(transactionsStore.get('tx-poll').status, 'processing');
      } finally {
        poller.stop();
      }
    });
  });
});
