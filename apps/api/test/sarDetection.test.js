'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const mockPrisma = {
  transaction: { findMany: async () => [] },
  sarReport: { create: async () => {}, findFirst: async () => null },
  notification: { create: async () => {} },
};

require.cache[require.resolve('../src/common/prisma')] = { exports: mockPrisma };

let auditLogs = [];
require.cache[require.resolve('../src/common/audit.service')] = {
  exports: {
    writeAuditLog: async (log) => {
      auditLogs.push(log);
      return { id: 'audit-log-1', ...log };
    },
  },
};

const sar = require('../src/compliance/sarDetection');

const NOW = Date.parse('2026-11-24T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

describe('SAR Automated Detection (#986)', () => {
  beforeEach(() => {
    auditLogs = [];
    mockPrisma.transaction.findMany = async () => [];
    mockPrisma.sarReport.create = async ({ data }) => ({ id: 'sar-123', ...data });
    mockPrisma.sarReport.findFirst = async () => null;
    mockPrisma.notification.create = async ({ data }) => ({ id: 'notif-123', ...data });
  });

  describe('toUsdNumber', () => {
    test('parses USDC amounts 1:1', () => {
      assert.equal(sar.toUsdNumber({ amount: '9500.00', asset: 'USDC' }), 9500);
      assert.equal(sar.toUsdNumber({ amount: '100.50' }), 100.50);
    });

    test('parses fiatAmount when fiatCurrency is USD', () => {
      assert.equal(sar.toUsdNumber({ fiatAmount: '8900.00', fiatCurrency: 'USD' }), 8900);
    });

    test('handles invalid or empty gracefully', () => {
      assert.equal(sar.toUsdNumber(null), 0);
      assert.equal(sar.toUsdNumber({ amount: 'invalid' }), 0);
    });
  });

  describe('detectStructuring rule evaluation', () => {
    test('returns not suspicious for low amounts or single transfer', () => {
      const txs = [
        { id: 't1', amount: '200.00', asset: 'USDC', status: 'completed', createdAt: new Date(NOW - 2 * DAY_MS) },
        { id: 't2', amount: '500.00', asset: 'USDC', status: 'completed', createdAt: new Date(NOW - 1 * DAY_MS) },
      ];
      const res = sar.detectStructuring({ transactions: txs });
      assert.equal(res.isSuspicious, false);
      assert.equal(res.suspiciousTransactions.length, 0);
    });

    test('returns not suspicious for a single legitimate sub-threshold transfer', () => {
      const txs = [
        { id: 't1', amount: '9500.00', asset: 'USDC', status: 'completed', createdAt: new Date(NOW - 1 * DAY_MS) },
      ];
      const res = sar.detectStructuring({ transactions: txs });
      assert.equal(res.isSuspicious, false);
    });

    test('flags near-threshold structuring (smurfing) with 2 transfers around $9,500', () => {
      const txs = [
        { id: 't1', amount: '9500.00', asset: 'USDC', status: 'completed', createdAt: new Date(NOW - 3 * DAY_MS) },
        { id: 't2', amount: '9200.00', asset: 'USDC', status: 'completed', createdAt: new Date(NOW - 1 * DAY_MS) },
      ];
      const res = sar.detectStructuring({ transactions: txs });
      assert.equal(res.isSuspicious, true);
      assert.equal(res.rule, sar.RULES.NEAR_THRESHOLD_STRUCTURING);
      assert.equal(res.suspiciousTransactions.length, 2);
      assert.equal(res.totalAmountUsd, '18700.00');
      assert.ok(res.narrative.includes('Structuring / Smurfing identified'));
    });

    test('flags rapid sub-threshold aggregate smurfing (multiple transactions summing > $10k)', () => {
      const txs = [
        { id: 't1', amount: '3500.00', asset: 'USDC', status: 'completed', createdAt: new Date(NOW - 5 * DAY_MS) },
        { id: 't2', amount: '4000.00', asset: 'USDC', status: 'completed', createdAt: new Date(NOW - 3 * DAY_MS) },
        { id: 't3', amount: '3200.00', asset: 'USDC', status: 'completed', createdAt: new Date(NOW - 1 * DAY_MS) },
      ];
      const res = sar.detectStructuring({ transactions: txs });
      assert.equal(res.isSuspicious, true);
      assert.equal(res.rule, sar.RULES.RAPID_SUB_THRESHOLD_AGGREGATE);
      assert.equal(res.suspiciousTransactions.length, 3);
      assert.equal(res.totalAmountUsd, '10700.00');
    });

    test('ignores failed or cancelled transactions', () => {
      const txs = [
        { id: 't1', amount: '9500.00', asset: 'USDC', status: 'failed', createdAt: new Date(NOW - 3 * DAY_MS) },
        { id: 't2', amount: '9200.00', asset: 'USDC', status: 'cancelled', createdAt: new Date(NOW - 2 * DAY_MS) },
      ];
      const res = sar.detectStructuring({ transactions: txs });
      assert.equal(res.isSuspicious, false);
    });
  });

  describe('analyzeUserTransfers and database queries', () => {
    test('queries transactions within 7-day window and detects smurfing', async () => {
      let queriedWhere = null;
      mockPrisma.transaction.findMany = async ({ where }) => {
        queriedWhere = where;
        return [
          { id: 'tx-1', amount: '9800.00', asset: 'USDC', status: 'completed', createdAt: new Date(NOW - 2 * DAY_MS) },
          { id: 'tx-2', amount: '9500.00', asset: 'USDC', status: 'completed', createdAt: new Date(NOW - 1 * DAY_MS) },
        ];
      };

      const res = await sar.analyzeUserTransfers({
        userId: 'user-abc',
        now: new Date(NOW),
        windowDays: 7,
        prismaClient: mockPrisma,
      });

      assert.ok(queriedWhere);
      assert.equal(queriedWhere.userId, 'user-abc');
      assert.equal(res.isSuspicious, true);
      assert.equal(res.suspiciousTransactions.length, 2);
    });
  });

  describe('generateSarDraft and compliance alert', () => {
    test('creates draft SAR report, writes audit log, and dispatches alert', async () => {
      let createdReport = null;
      let createdNotif = null;

      mockPrisma.sarReport.create = async ({ data }) => {
        createdReport = data;
        return { id: 'sar-rep-1', ...data };
      };

      mockPrisma.notification.create = async ({ data }) => {
        createdNotif = data;
        return { id: 'notif-1', ...data };
      };

      const detectionResult = {
        isSuspicious: true,
        rule: sar.RULES.NEAR_THRESHOLD_STRUCTURING,
        reasons: ['Transactions structured below $10,000.00'],
        suspiciousTransactions: [{ id: 'tx-1' }, { id: 'tx-2' }],
        totalAmountUsd: '19300.00',
        narrative: 'Automated SAR Draft narrative for structuring.',
      };

      const result = await sar.generateSarDraft({
        userId: 'user-xyz',
        detectionResult,
        prismaClient: mockPrisma,
      });

      assert.equal(result.created, true);
      assert.equal(result.alertTriggered, true);

      // Verify SAR report draft fields
      assert.ok(createdReport);
      assert.equal(createdReport.userId, 'user-xyz');
      assert.equal(createdReport.status, 'draft');
      assert.ok(createdReport.reportNumber.startsWith('SAR-'));
      assert.deepEqual(createdReport.transactionIds, ['tx-1', 'tx-2']);
      assert.equal(createdReport.totalAmountUsd, '19300.00');

      // Verify Audit Log entry
      assert.equal(auditLogs.length, 1);
      assert.equal(auditLogs[0].action, 'compliance.sar.draft_created');
      assert.equal(auditLogs[0].entityType, 'SarReport');
      assert.equal(auditLogs[0].metadata.userId, 'user-xyz');

      // Verify Compliance Notification Alert
      assert.ok(createdNotif);
      assert.equal(createdNotif.channel, 'compliance');
      assert.equal(createdNotif.type, 'COMPLIANCE_SAR_ALERT');
      assert.ok(createdNotif.body.includes('SUSPICIOUS ACTIVITY ALERT'));
      assert.equal(createdNotif.referenceType, 'SarReport');
    });

    test('deduplicates and prevents spamming duplicate SAR drafts for identical transactions', async () => {
      mockPrisma.sarReport.findFirst = async () => ({
        id: 'sar-existing',
        transactionIds: ['tx-1', 'tx-2'],
        status: 'draft',
      });

      const detectionResult = {
        isSuspicious: true,
        rule: sar.RULES.NEAR_THRESHOLD_STRUCTURING,
        suspiciousTransactions: [{ id: 'tx-1' }, { id: 'tx-2' }],
        totalAmountUsd: '19300.00',
      };

      const result = await sar.generateSarDraft({
        userId: 'user-xyz',
        detectionResult,
        prismaClient: mockPrisma,
      });

      assert.equal(result.created, false);
      assert.equal(result.duplicate, true);
      assert.equal(auditLogs.length, 0);
    });
  });

  describe('evaluateAndReportSar end-to-end integration', () => {
    test('triggers SAR draft and alert when user pattern is suspicious', async () => {
      mockPrisma.transaction.findMany = async () => [
        { id: 'tx-1', amount: '9500.00', asset: 'USDC', status: 'completed', createdAt: new Date(NOW - 2 * DAY_MS) },
        { id: 'tx-2', amount: '9200.00', asset: 'USDC', status: 'completed', createdAt: new Date(NOW - 1 * DAY_MS) },
      ];

      const res = await sar.evaluateAndReportSar({
        userId: 'user-suspect',
        now: new Date(NOW),
        prismaClient: mockPrisma,
      });

      assert.equal(res.created, true);
      assert.equal(res.alertTriggered, true);
      assert.ok(res.report);
      assert.equal(res.report.userId, 'user-suspect');
      assert.equal(auditLogs.length, 1);
    });

    test('does not create SAR draft when user pattern is clean', async () => {
      mockPrisma.transaction.findMany = async () => [
        { id: 'tx-1', amount: '50.00', asset: 'USDC', status: 'completed', createdAt: new Date(NOW - 1 * DAY_MS) },
      ];

      const res = await sar.evaluateAndReportSar({
        userId: 'user-clean',
        now: new Date(NOW),
        prismaClient: mockPrisma,
      });

      assert.equal(res.created, false);
      assert.equal(res.isSuspicious, false);
      assert.equal(auditLogs.length, 0);
    });
  });
});
