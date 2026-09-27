'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const injectMock = (relativeFromSrc, factory) => {
  const abs = path.resolve(__dirname, '../src', `${relativeFromSrc}.js`);
  require.cache[abs] = {
    id: abs,
    filename: abs,
    loaded: true,
    exports: factory(),
  };
};

let auditLogs = [];
let errorLogs = [];

const prismaMock = {
  user: {
    findUnique: async () => null,
  },
  kycProfile: {
    findUnique: async () => null,
    findMany: async () => [],
  },
  transaction: {
    findMany: async () => [],
  },
  accountStatusRecord: {
    findMany: async () => [],
  },
  auditLog: {
    findMany: async () => [],
  },
  workflowEvent: {
    findMany: async () => [],
  },
};

injectMock('common/prisma', () => prismaMock);
injectMock('common/audit.service', () => ({
  writeAuditLog: async (entry) => {
    auditLogs.push(entry);
    return { id: 'audit_created_1' };
  },
}));
injectMock('utils/logger', () => ({
  info: () => {},
  error: (...args) => {
    errorLogs.push(args);
  },
}));

const evidenceService = require('../src/compliance/evidence.service');

describe('evidence.service.js unit tests', () => {
  beforeEach(() => {
    auditLogs = [];
    errorLogs = [];
  });

  describe('buildUserEvidencePackage', () => {
    test('successfully builds full evidence package for an existing user', async () => {
      const mockUser = {
        id: 'usr_123',
        phoneNumber: '+2348012345678',
        whatsappName: 'Ada Lovelace',
        kycTier: 2,
        riskScore: 15,
        locale: 'en',
        messagingConsent: true,
        createdAt: new Date('2026-01-01T10:00:00.000Z'),
        updatedAt: new Date('2026-01-02T10:00:00.000Z'),
        deactivatedAt: null,
        deactivationReason: null,
        anonymizedAt: null,
      };
      const mockKyc = {
        id: 'kyc_123',
        userId: 'usr_123',
        tier: 2,
        status: 'approved',
        screeningResults: [
          {
            id: 'scr_1',
            status: 'cleared',
            provider: 'smileid',
            screenedAt: new Date('2026-01-01T11:00:00.000Z'),
          },
        ],
      };
      const mockTx = [
        {
          id: 'tx_1',
          type: 'payout',
          amount: '100.00',
          asset: 'USDC',
          fiatCurrency: 'NGN',
          fiatAmount: '150000.00',
          rail: 'stellar',
          routeType: 'direct',
          destination: 'GDEST...',
          recipientPhoneNumber: '+2348099999999',
          txHash: 'hash_123',
          status: 'completed',
          createdAt: new Date('2026-01-02T12:00:00.000Z'),
          updatedAt: new Date('2026-01-02T12:05:00.000Z'),
        },
      ];
      const mockAccountHistory = [
        {
          id: 'asr_1',
          userId: 'usr_123',
          status: 'active',
          reason: 'Initial onboarding',
          createdAt: new Date('2026-01-01T10:00:00.000Z'),
        },
      ];
      const mockAuditEntries = [
        {
          id: 'aud_1',
          action: 'user.login',
          entityId: 'usr_123',
          createdAt: new Date('2026-01-01T10:05:00.000Z'),
        },
      ];
      const mockEvents = [
        {
          id: 'wev_1',
          eventType: 'UserCreated',
          aggregateType: 'User',
          aggregateId: 'usr_123',
          createdAt: new Date('2026-01-01T10:00:00.000Z'),
        },
      ];

      prismaMock.user.findUnique = async () => mockUser;
      prismaMock.kycProfile.findUnique = async () => mockKyc;
      prismaMock.transaction.findMany = async () => mockTx;
      prismaMock.accountStatusRecord.findMany = async () => mockAccountHistory;
      prismaMock.auditLog.findMany = async () => mockAuditEntries;
      prismaMock.workflowEvent.findMany = async () => mockEvents;

      const result = await evidenceService.buildUserEvidencePackage({
        userId: 'usr_123',
        actingAdminId: 'adm_999',
        req: { ip: '127.0.0.1' },
      });

      assert.equal(result.subject.userId, 'usr_123');
      assert.equal(result.subject.phoneNumber, '+2348012345678');
      assert.equal(result.exportedBy, 'adm_999');
      assert.deepEqual(result.user, mockUser);
      assert.deepEqual(result.kyc, mockKyc);
      assert.deepEqual(result.transactions, mockTx);
      assert.deepEqual(result.accountStatusHistory, mockAccountHistory);
      assert.deepEqual(result.auditLog, mockAuditEntries);
      assert.deepEqual(result.workflowEvents, mockEvents);
      assert.ok(result.exportedAt);

      assert.equal(auditLogs.length, 1);
      assert.equal(auditLogs[0].action, 'admin.compliance.evidence.exported');
      assert.equal(auditLogs[0].entityId, 'usr_123');
      assert.equal(auditLogs[0].metadata.exportType, 'user_evidence_package');
      assert.equal(auditLogs[0].metadata.transactionCount, 1);
      assert.equal(auditLogs[0].metadata.auditEntryCount, 1);
      assert.equal(auditLogs[0].metadata.eventCount, 1);
    });

    test('handles user without KYC profile gracefully (kyc is null)', async () => {
      const mockUser = {
        id: 'usr_nokyc',
        phoneNumber: '+2348000000000',
        kycTier: 0,
      };

      prismaMock.user.findUnique = async () => mockUser;
      prismaMock.kycProfile.findUnique = async () => null;
      prismaMock.transaction.findMany = async () => [];
      prismaMock.accountStatusRecord.findMany = async () => [];
      prismaMock.auditLog.findMany = async () => [];
      prismaMock.workflowEvent.findMany = async () => [];

      const result = await evidenceService.buildUserEvidencePackage({
        userId: 'usr_nokyc',
        actingAdminId: 'adm_999',
      });

      assert.equal(result.user.id, 'usr_nokyc');
      assert.equal(result.kyc, null);
    });

    test('throws 404 when user is not found', async () => {
      prismaMock.user.findUnique = async () => null;
      prismaMock.kycProfile.findUnique = async () => null;
      prismaMock.transaction.findMany = async () => [];
      prismaMock.accountStatusRecord.findMany = async () => [];
      prismaMock.auditLog.findMany = async () => [];
      prismaMock.workflowEvent.findMany = async () => [];

      await assert.rejects(
        async () => {
          await evidenceService.buildUserEvidencePackage({
            userId: 'usr_missing',
            actingAdminId: 'adm_999',
          });
        },
        (err) => {
          assert.equal(err.message, 'User not found');
          assert.equal(err.statusCode, 404);
          return true;
        },
      );
    });

    test('catches and logs audit log failure without throwing', async () => {
      const mockUser = { id: 'usr_audit_fail', phoneNumber: '+123456789' };
      prismaMock.user.findUnique = async () => mockUser;
      prismaMock.kycProfile.findUnique = async () => null;
      prismaMock.transaction.findMany = async () => [];
      prismaMock.accountStatusRecord.findMany = async () => [];
      prismaMock.auditLog.findMany = async () => [];
      prismaMock.workflowEvent.findMany = async () => [];

      injectMock('common/audit.service', () => ({
        writeAuditLog: async () => {
          throw new Error('Database write error');
        },
      }));

      // Re-require service with failing audit log
      delete require.cache[path.resolve(__dirname, '../src/compliance/evidence.service.js')];
      const reloadedService = require('../src/compliance/evidence.service');

      const result = await reloadedService.buildUserEvidencePackage({
        userId: 'usr_audit_fail',
        actingAdminId: 'adm_999',
      });

      assert.equal(result.user.id, 'usr_audit_fail');
      assert.equal(errorLogs.length, 1);
      assert.equal(errorLogs[0][0], 'Audit log failed for evidence export');
      assert.equal(errorLogs[0][1], 'Database write error');

      // Restore working audit service
      injectMock('common/audit.service', () => ({
        writeAuditLog: async (entry) => {
          auditLogs.push(entry);
          return { id: 'audit_created_1' };
        },
      }));
      delete require.cache[path.resolve(__dirname, '../src/compliance/evidence.service.js')];
    });
  });

  describe('exportWorkflowEventsCsv', () => {
    test('exports workflow events to CSV with all columns and filters applied', async () => {
      const mockEvents = [
        {
          id: 'ev_1',
          eventType: 'TransferInitiated',
          aggregateType: 'Transaction',
          aggregateId: 'tx_123',
          actorType: 'user',
          actorId: 'usr_1',
          payload: { amount: '100,00', note: 'Quote "test"\nnewline' },
          createdAt: new Date('2026-01-01T12:00:00.000Z'),
        },
      ];

      let capturedWhere = null;
      prismaMock.workflowEvent.findMany = async ({ where }) => {
        capturedWhere = where;
        return mockEvents;
      };

      const csv = await evidenceService.exportWorkflowEventsCsv({
        filters: {
          eventType: 'TransferInitiated',
          aggregateType: 'Transaction',
          aggregateId: 'tx_123',
          from: '2026-01-01T00:00:00.000Z',
          to: '2026-01-02T00:00:00.000Z',
        },
        actingAdminId: 'adm_1',
      });

      assert.equal(capturedWhere.eventType, 'TransferInitiated');
      assert.equal(capturedWhere.aggregateType, 'Transaction');
      assert.equal(capturedWhere.aggregateId, 'tx_123');
      assert.deepEqual(capturedWhere.createdAt.gte, new Date('2026-01-01T00:00:00.000Z'));
      assert.deepEqual(capturedWhere.createdAt.lte, new Date('2026-01-02T00:00:00.000Z'));

      assert.ok(csv.startsWith('id,eventType,aggregateType,aggregateId,actorType,actorId,payload,createdAt\n'));
      assert.ok(csv.includes('ev_1,TransferInitiated,Transaction,tx_123,user,usr_1,'));
      // Check JSON payload escaping
      assert.ok(csv.includes('""amount""'));

      assert.equal(auditLogs.length, 1);
      assert.equal(auditLogs[0].action, 'admin.compliance.events.exported');
      assert.equal(auditLogs[0].metadata.rows, 1);
      assert.equal(auditLogs[0].metadata.capped, false);
    });

    test('handles default empty filters and empty results in workflow events export', async () => {
      let capturedWhere = null;
      prismaMock.workflowEvent.findMany = async ({ where }) => {
        capturedWhere = where;
        return [];
      };

      const csv = await evidenceService.exportWorkflowEventsCsv({
        actingAdminId: 'adm_1',
      });

      assert.deepEqual(capturedWhere, {});
      assert.equal(csv, 'id,eventType,aggregateType,aggregateId,actorType,actorId,payload,createdAt\n\n');
    });
  });

  describe('exportKycEvidenceCsv', () => {
    test('exports KYC profiles with latest screening results to CSV with filtering', async () => {
      const mockProfiles = [
        {
          id: 'kyc_1',
          user: { phoneNumber: '+2348011111111', whatsappName: 'Bob' },
          provider: 'smileid',
          tier: 1,
          status: 'approved',
          country: 'NG',
          riskScore: 10,
          sanctionsStatus: 'cleared',
          custodyStatus: 'approved',
          screeningResults: [
            {
              status: 'passed',
              provider: 'smileid',
              screenedAt: new Date('2026-01-05T08:00:00.000Z'),
            },
          ],
          updatedAt: new Date('2026-01-05T09:00:00.000Z'),
          createdAt: new Date('2026-01-01T09:00:00.000Z'),
        },
      ];

      let capturedWhere = null;
      prismaMock.kycProfile.findMany = async ({ where }) => {
        capturedWhere = where;
        return mockProfiles;
      };

      const csv = await evidenceService.exportKycEvidenceCsv({
        filters: {
          status: 'approved',
          country: 'NG',
          from: '2026-01-01T00:00:00.000Z',
          to: '2026-01-06T00:00:00.000Z',
        },
        actingAdminId: 'adm_2',
      });

      assert.equal(capturedWhere.status, 'approved');
      assert.equal(capturedWhere.country, 'NG');
      assert.deepEqual(capturedWhere.updatedAt.gte, new Date('2026-01-01T00:00:00.000Z'));
      assert.deepEqual(capturedWhere.updatedAt.lte, new Date('2026-01-06T00:00:00.000Z'));

      assert.ok(csv.startsWith('id,phoneNumber,provider,tier,status,country,riskScore,sanctionsStatus,custodyStatus,latestScreeningStatus,latestScreeningProvider,latestScreenedAt,updatedAt,createdAt\n'));
      assert.ok(csv.includes('kyc_1,+2348011111111,smileid,1,approved,NG,10,cleared,approved,passed,smileid,2026-01-05T08:00:00.000Z,2026-01-05T09:00:00.000Z,2026-01-01T09:00:00.000Z'));

      assert.equal(auditLogs.length, 1);
      assert.equal(auditLogs[0].action, 'admin.compliance.kyc_evidence.exported');
    });

    test('handles KYC profile without user and screeningResults', async () => {
      const mockProfiles = [
        {
          id: 'kyc_empty',
          user: null,
          provider: 'smileid',
          tier: 0,
          status: 'unverified',
          country: null,
          riskScore: null,
          sanctionsStatus: null,
          custodyStatus: null,
          screeningResults: [],
          updatedAt: null,
          createdAt: null,
        },
      ];

      prismaMock.kycProfile.findMany = async () => mockProfiles;

      const csv = await evidenceService.exportKycEvidenceCsv({
        actingAdminId: 'adm_2',
      });

      assert.ok(csv.includes('kyc_empty,,smileid,0,unverified'));
    });
  });

  describe('exportAccountStatusHistoryCsv', () => {
    test('exports account status history records to CSV with filters applied', async () => {
      const mockRecords = [
        {
          id: 'asr_1',
          userId: 'usr_1',
          user: { phoneNumber: '+2348012345678' },
          status: 'suspended',
          reason: 'Suspicious activity, AML alert',
          notes: 'Case #42',
          initiatedBy: 'adm_1',
          approvedBy: 'adm_2',
          approvedAt: new Date('2026-01-03T10:00:00.000Z'),
          effectiveAt: new Date('2026-01-03T10:00:00.000Z'),
          createdAt: new Date('2026-01-03T09:00:00.000Z'),
        },
      ];

      let capturedWhere = null;
      prismaMock.accountStatusRecord.findMany = async ({ where }) => {
        capturedWhere = where;
        return mockRecords;
      };

      const csv = await evidenceService.exportAccountStatusHistoryCsv({
        filters: {
          userId: 'usr_1',
          status: 'suspended',
          from: '2026-01-01T00:00:00.000Z',
          to: '2026-01-04T00:00:00.000Z',
        },
        actingAdminId: 'adm_3',
      });

      assert.equal(capturedWhere.userId, 'usr_1');
      assert.equal(capturedWhere.status, 'suspended');
      assert.deepEqual(capturedWhere.createdAt.gte, new Date('2026-01-01T00:00:00.000Z'));
      assert.deepEqual(capturedWhere.createdAt.lte, new Date('2026-01-04T00:00:00.000Z'));

      assert.ok(csv.startsWith('id,userId,phoneNumber,status,reason,notes,initiatedBy,approvedBy,approvedAt,effectiveAt,createdAt\n'));
      assert.ok(csv.includes('asr_1,usr_1,+2348012345678,suspended,"Suspicious activity, AML alert",Case #42,adm_1,adm_2,2026-01-03T10:00:00.000Z,2026-01-03T10:00:00.000Z,2026-01-03T09:00:00.000Z'));

      assert.equal(auditLogs.length, 1);
      assert.equal(auditLogs[0].action, 'admin.compliance.account_status.exported');
      assert.equal(auditLogs[0].metadata.rows, 1);
    });

    test('handles account status record with null user relation', async () => {
      const mockRecords = [
        {
          id: 'asr_nouser',
          userId: 'usr_deleted',
          user: null,
          status: 'deleted',
          reason: 'GDPR erasure',
          notes: null,
          initiatedBy: 'system',
          approvedBy: null,
          approvedAt: null,
          effectiveAt: null,
          createdAt: null,
        },
      ];

      prismaMock.accountStatusRecord.findMany = async () => mockRecords;

      const csv = await evidenceService.exportAccountStatusHistoryCsv({
        actingAdminId: 'adm_3',
      });

      assert.ok(csv.includes('asr_nouser,usr_deleted,,deleted,GDPR erasure,,system,,,,'));
    });
  });

  test('MAX_EXPORT_ROWS constant is exported and has value 5000', () => {
    assert.equal(evidenceService.MAX_EXPORT_ROWS, 5000);
  });
});
