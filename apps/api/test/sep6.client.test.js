'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { Keypair } = require('@stellar/stellar-sdk');

const sep6Client = require('../src/services/sep6.client');

const ANCHOR_ACCOUNT = Keypair.random().publicKey();
const USER_ACCOUNT = Keypair.random().publicKey();
const MUXED_ACCOUNT = 'MAAAAAAAAAAAAAB7BQ2L7E5NBWMXDUCMZSIPOBKRDSBYVLMXGSSKF6YNPIB7Y77ITLVL6';

const anchorRequests = [];
let nextAnchorWithdrawOverride = null;
let anchorMode = 'ok';

const createMockSep6AnchorApp = () => {
  const app = express();

  app.get('/info', (_req, res) => {
    res.status(200).json({
      deposit: {
        USDC: { enabled: true, min_amount: 5, max_amount: 5000, fee_fixed: 0.5 },
        KES: { enabled: true, min_amount: 100, max_amount: 500000 },
      },
      withdraw: {
        USDC: {
          enabled: true,
          min_amount: 5,
          max_amount: 5000,
          types: {
            mpesa: { fields: { dest: { description: 'M-Pesa phone number' } } },
            mtn_mobile_money: { fields: { dest: { description: 'MTN MoMo number' } } },
            bank_account: { fields: { dest: { description: 'Bank account' }, dest_extra: { description: 'Routing/bank code' } } },
          },
        },
      },
      fee: { enabled: true },
      transactions: { enabled: true },
      transaction: { enabled: true },
    });
  });

  app.get('/fee', (req, res) => {
    anchorRequests.push({ path: '/fee', query: req.query });
    res.status(200).json({ fee: 1.25 });
  });

  app.get('/deposit', (req, res) => {
    anchorRequests.push({ path: '/deposit', query: req.query, auth: req.headers.authorization || null });
    if (anchorMode === 'kyc_needed') {
      return res.status(403).json({
        type: 'non_interactive_customer_info_needed',
        fields: ['first_name', 'last_name', 'id_number'],
      });
    }
    return res.status(200).json({
      id: 'sep6-dep-1',
      how: 'Paybill 123456, Account SENDAM-DEP-1',
      eta: 300,
      min_amount: 5,
      max_amount: 5000,
      fee_fixed: 0.5,
      extra_info: { message: 'Send via M-Pesa Paybill' },
    });
  });

  app.get('/withdraw', (req, res) => {
    anchorRequests.push({ path: '/withdraw', query: req.query, auth: req.headers.authorization || null });

    if (anchorMode === 'kyc_needed') {
      return res.status(403).json({
        type: 'non_interactive_customer_info_needed',
        fields: ['first_name', 'last_name', 'bank_account_number'],
      });
    }
    if (anchorMode === 'kyc_status_pending') {
      return res.status(403).json({
        type: 'customer_info_status',
        status: 'pending',
        more_info_url: 'https://anchor.test/kyc/status/1',
        eta: 600,
      });
    }
    if (anchorMode === 'auth_required') {
      return res.status(403).json({
        type: 'authentication_required',
      });
    }
    if (anchorMode === 'server_error') {
      return res.status(500).json({ error: 'anchor internal failure' });
    }

    if (nextAnchorWithdrawOverride) {
      const body = nextAnchorWithdrawOverride;
      nextAnchorWithdrawOverride = null;
      return res.status(200).json(body);
    }

    const memoType = req.query.type === 'bank_account' ? 'hash' : 'id';
    const memo = memoType === 'hash'
      ? crypto.createHash('sha256').update('sep6-bank-wd-1').digest('base64')
      : '987654321';

    return res.status(200).json({
      id: `sep6-wd-${anchorRequests.length}`,
      account_id: ANCHOR_ACCOUNT,
      memo_type: memoType,
      memo,
      eta: 180,
      min_amount: 5,
      max_amount: 5000,
      fee_fixed: 0.5,
      fee_percent: 0.5,
      extra_info: {
        message: 'Include the memo so your payout clears automatically',
      },
    });
  });

  app.get('/transaction', (req, res) => {
    anchorRequests.push({ path: '/transaction', query: req.query });
    return res.status(200).json({
      transaction: {
        id: req.query.id || 'sep6-wd-1',
        kind: 'withdrawal',
        status: 'completed',
        amount_in: '50',
        amount_out: '6450',
      },
    });
  });

  app.get('/transactions', (req, res) => {
    anchorRequests.push({ path: '/transactions', query: req.query });
    return res.status(200).json({
      transactions: [
        { id: 'sep6-wd-1', kind: 'withdrawal', status: 'completed' },
      ],
    });
  });

  return app;
};

const withAnchorServer = async (run) => {
  const server = http.createServer(createMockSep6AnchorApp());
  await new Promise((resolve) => server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

beforeEach(() => {
  anchorRequests.length = 0;
  nextAnchorWithdrawOverride = null;
  anchorMode = 'ok';
});

describe('SEP-6 Programmatic Deposit and Withdrawal Client (#949)', () => {
  test('queries /info, /fee, /deposit, /transaction, and /transactions against SEP-6 anchor', async () => {
    await withAnchorServer(async (baseUrl) => {
      const info = await sep6Client.getInfo({ transferServerUrl: baseUrl });
      assert.equal(info.withdraw.USDC.enabled, true);

      const fee = await sep6Client.getFee({
        transferServerUrl: baseUrl,
        operation: 'withdraw',
        type: 'mpesa',
        assetCode: 'USDC',
        amount: '50',
      });
      assert.equal(fee.fee, 1.25);

      const deposit = await sep6Client.requestDeposit({
        transferServerUrl: baseUrl,
        assetCode: 'USDC',
        account: USER_ACCOUNT,
        amount: '25.5',
        type: 'mpesa',
        jwt: 'sep10-jwt-token',
      });
      assert.equal(deposit.id, 'sep6-dep-1');
      assert.match(deposit.how, /Paybill 123456/);
      assert.equal(anchorRequests.find((r) => r.path === '/deposit').auth, 'Bearer sep10-jwt-token');

      const tx = await sep6Client.getTransaction({ transferServerUrl: baseUrl, id: 'sep6-wd-1', jwt: 'sep10-jwt-token' });
      assert.equal(tx.status, 'completed');

      const txs = await sep6Client.getTransactions({
        transferServerUrl: baseUrl,
        assetCode: 'USDC',
        account: USER_ACCOUNT,
        jwt: 'sep10-jwt-token',
      });
      assert.equal(txs.length, 1);
    });
  });

  test('submits M-Pesa and MTN Mobile Money withdrawal requests with canonicalized phone and memo', async () => {
    await withAnchorServer(async (baseUrl) => {
      const mpesa = await sep6Client.requestMobileMoneyWithdrawal({
        transferServerUrl: baseUrl,
        assetCode: 'USDC',
        rail: 'm-pesa',
        phoneNumber: '+254 712 345 678',
        account: USER_ACCOUNT,
        amount: '40',
        provider: 'safaricom',
        jwt: 'sep10-jwt',
      });

      assert.equal(mpesa.accountId, ANCHOR_ACCOUNT);
      assert.equal(mpesa.memo, '987654321');
      assert.equal(mpesa.memoType, 'id');
      assert.equal(anchorRequests[0].query.type, 'mpesa');
      assert.equal(anchorRequests[0].query.dest, '+254712345678');
      assert.equal(anchorRequests[0].query.dest_extra, 'safaricom');

      const mtn = await sep6Client.requestMobileMoneyWithdrawal({
        transferServerUrl: baseUrl,
        assetCode: 'USDC',
        rail: 'MTN',
        phoneNumber: '+233244000001',
        amount: '20',
      });

      assert.equal(mtn.accountId, ANCHOR_ACCOUNT);
      assert.equal(anchorRequests[1].query.type, 'mtn_mobile_money');
      assert.equal(anchorRequests[1].query.dest, '+233244000001');
    });
  });

  test('submits bank account withdrawal and normalizes base64 hash memo to hex', async () => {
    await withAnchorServer(async (baseUrl) => {
      const result = await sep6Client.requestBankWithdrawal({
        transferServerUrl: baseUrl,
        assetCode: 'USDC',
        accountNumber: '0123456789',
        bankCode: '058',
        routingCode: 'GTBINGLA',
        amount: '100',
        jwt: 'sep10-jwt',
      });

      const expectedHex = crypto.createHash('sha256').update('sep6-bank-wd-1').digest('hex');
      assert.equal(result.accountId, ANCHOR_ACCOUNT);
      assert.equal(result.memoType, 'hash');
      assert.equal(result.memo, expectedHex);
      assert.equal(anchorRequests[0].query.type, 'bank_account');
      assert.equal(anchorRequests[0].query.dest, '0123456789');
      assert.match(anchorRequests[0].query.dest_extra, /058/);
    });
  });

  test('executeProgrammaticWithdrawal fetches instructions, submits Stellar payment with memo, and persists transaction', async () => {
    await withAnchorServer(async (baseUrl) => {
      const submittedPayments = [];
      const persistedRows = [];
      const auditLogs = [];

      const mockPrisma = {
        transaction: {
          create: async ({ data }) => {
            const row = { id: `tx_${persistedRows.length + 1}`, ...data };
            persistedRows.push(row);
            return row;
          },
        },
      };

      const outcome = await sep6Client.executeProgrammaticWithdrawal(
        {
          transferServerUrl: baseUrl,
          assetCode: 'USDC',
          rail: 'mpesa',
          phoneNumber: '+254712345678',
          account: USER_ACCOUNT,
          amount: '75',
          userId: 'user_1',
          idempotencyKey: 'sep6-idem-1',
          jwt: 'sep10-jwt',
        },
        {
          submitPayment: async (args) => {
            submittedPayments.push(args);
            return { txHash: 'stellar-hash-sep6', explorerUrl: 'https://stellar.expert/tx/stellar-hash-sep6' };
          },
          prisma: mockPrisma,
          writeAuditLog: async (entry) => {
            auditLogs.push(entry);
          },
        },
      );

      assert.equal(submittedPayments.length, 1);
      assert.equal(submittedPayments[0].destination, ANCHOR_ACCOUNT);
      assert.equal(submittedPayments[0].amount, '75');
      assert.equal(submittedPayments[0].asset, 'USDC');
      assert.equal(submittedPayments[0].memo, '987654321');
      assert.equal(submittedPayments[0].memoType, 'id');

      assert.equal(persistedRows.length, 1);
      assert.equal(persistedRows[0].rail, 'sep6');
      assert.equal(persistedRows[0].type, 'withdraw');
      assert.equal(persistedRows[0].txHash, 'stellar-hash-sep6');
      assert.equal(outcome.transaction.id, 'tx_1');
      assert.equal(auditLogs.length, 1);
      assert.equal(auditLogs[0].action, 'sep6.withdrawal.submitted');
    });
  });

  test('handles SEP-6 403 non_interactive_customer_info_needed, customer_info_status, and authentication_required', async () => {
    await withAnchorServer(async (baseUrl) => {
      anchorMode = 'kyc_needed';
      await assert.rejects(
        () => sep6Client.requestMobileMoneyWithdrawal({
          transferServerUrl: baseUrl,
          assetCode: 'USDC',
          rail: 'mpesa',
          phoneNumber: '+254712345678',
        }),
        (err) => err.code === 'kyc_info_needed'
          && err.statusCode === 403
          && Array.isArray(err.fields)
          && err.fields.includes('first_name'),
      );

      anchorMode = 'kyc_status_pending';
      await assert.rejects(
        () => sep6Client.requestMobileMoneyWithdrawal({
          transferServerUrl: baseUrl,
          assetCode: 'USDC',
          rail: 'mpesa',
          phoneNumber: '+254712345678',
        }),
        (err) => err.code === 'kyc_status'
          && err.kycStatus === 'pending'
          && err.moreInfoUrl === 'https://anchor.test/kyc/status/1',
      );

      anchorMode = 'auth_required';
      await assert.rejects(
        () => sep6Client.requestMobileMoneyWithdrawal({
          transferServerUrl: baseUrl,
          assetCode: 'USDC',
          rail: 'mpesa',
          phoneNumber: '+254712345678',
        }),
        (err) => err.code === 'sep6_unauthorized' && err.statusCode === 403,
      );
    });
  });

  test('validates inputs and rejects malformed anchor withdrawal instructions', async () => {
    await assert.rejects(
      () => sep6Client.requestWithdrawal({ assetCode: 'USDC', type: 'mpesa', dest: '+254712345678' }),
      { code: 'missing_transfer_server_url' },
    );

    await assert.rejects(
      () => sep6Client.requestMobileMoneyWithdrawal({
        transferServerUrl: 'http://127.0.0.1:9999',
        assetCode: 'USDC',
        rail: 'mpesa',
        phoneNumber: 'not-a-phone',
      }),
      { code: 'invalid_phone_number' },
    );

    await assert.rejects(
      () => sep6Client.requestBankWithdrawal({
        transferServerUrl: 'http://127.0.0.1:9999',
        assetCode: 'USDC',
        accountNumber: '',
      }),
      { code: 'invalid_parameter' },
    );

    await withAnchorServer(async (baseUrl) => {
      nextAnchorWithdrawOverride = {
        id: 'bad-1',
        account_id: 'NOT_A_STELLAR_ADDRESS',
        memo: '123',
        memo_type: 'id',
      };
      await assert.rejects(
        () => sep6Client.requestMobileMoneyWithdrawal({
          transferServerUrl: baseUrl,
          assetCode: 'USDC',
          rail: 'mpesa',
          phoneNumber: '+254712345678',
        }),
        { code: 'invalid_anchor_instructions', statusCode: 502 },
      );

      nextAnchorWithdrawOverride = {
        id: 'bad-2',
        account_id: MUXED_ACCOUNT,
        memo: 'conflict',
        memo_type: 'text',
      };
      await assert.rejects(
        () => sep6Client.requestMobileMoneyWithdrawal({
          transferServerUrl: baseUrl,
          assetCode: 'USDC',
          rail: 'mpesa',
          phoneNumber: '+254712345678',
        }),
        { code: 'invalid_anchor_instructions', statusCode: 502 },
      );

      anchorMode = 'server_error';
      await assert.rejects(
        () => sep6Client.requestMobileMoneyWithdrawal({
          transferServerUrl: baseUrl,
          assetCode: 'USDC',
          rail: 'mpesa',
          phoneNumber: '+254712345678',
        }),
        { code: 'sep6_anchor_error', statusCode: 500 },
      );
    });
  });
});
