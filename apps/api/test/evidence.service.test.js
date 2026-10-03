const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';

const prisma = require('../src/common/prisma');

// Mock prisma models before requiring the evidence service
prisma.user = { findUnique: async () => null };
prisma.kycProfile = { findUnique: async () => null, findMany: async () => [] };
prisma.transaction = { findMany: async () => [] };
prisma.accountStatusRecord = { findMany: async () => [] };
prisma.auditLog = { findMany: async () => [], create: async () => ({ id: 'aud-1' }) };
prisma.workflowEvent = { findMany: async () => [] };
prisma.$transaction = async (cb) => cb(prisma);

const evidenceService = require('../src/compliance/evidence.service');

describe('evidence.service', () => {
  beforeEach(() => {
    prisma.user.findUnique = async () => null;
    prisma.kycProfile.findUnique = async () => null;
    prisma.kycProfile.findMany = async () => [];
    prisma.transaction.findMany = async () => [];
    prisma.accountStatusRecord.findMany = async () => [];
    prisma.auditLog.findMany = async () => [];
    prisma.auditLog.create = async () => ({ id: 'aud-1' });
    prisma.workflowEvent.findMany = async () => [];
  });

  describe('buildUserEvidencePackage', () => {
    it('throws 404 when user is not found', async () => {
      prisma.user.findUnique = async () => null;

      await assert.rejects(
        async () => {
          await evidenceService.buildUserEvidencePackage({
            userId: 'user-nonexistent',
            actingAdminId: 'admin-1',
          });
        },
        (err) => {
          assert.equal(err.statusCode, 404);
          assert.equal(err.message, 'User not found');
          return true;
        },
      );
    });

    it('builds a complete structured evidence package for an existing user', async () => {
      const mockUser = {
        id: 'usr-123',
        phoneNumber: '+2348012345678',
        whatsappName: 'Test User',
        kycTier: 1,
        riskScore: 10,
        locale: 'en',
        messagingConsent: true,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-02T00:00:00.000Z'),
        deactivatedAt: null,
        deactivationReason: null,
        anonymizedAt: null,
      };

      const mockKyc = {
        id: 'kyc-1',
        userId: 'usr-123',
        status: 'approved',
        tier: 1,
        screeningResults: [{ id: 'scr-1', status: 'clear', provider: 'smile_id', screenedAt: new Date('2026-01-01') }],
      };

      const mockTransactions = [
        {
          id: 'tx-1',
          type: 'send',
          amount: '100',
          asset: 'USDC',
          fiatCurrency: 'NGN',
          fiatAmount: '150000',
          rail: 'stellar',
          routeType: 'direct',
          destination: 'GABC...',
          recipientPhoneNumber: '+2348099999999',
          txHash: 'hash-1',
          status: 'completed',
          createdAt: new Date('2026-01-01T12:00:00.000Z'),
          updatedAt: new Date('2026-01-01T12:01:00.000Z'),
        },
      ];

      const mockAccountHistory = [
        {
          id: 'asr-1',
          userId: 'usr-123',
          status: 'active',
          reason: 'Initial onboarding',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ];

      const mockAuditEntries = [
        {
          id: 'aud-10',
          actorType: 'user',
          actorId: 'usr-123',
          action: 'auth.login',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ];

      const mockEvents = [
        {
          id: 'ev-1',
          aggregateType: 'User',
          aggregateId: 'usr-123',
          eventType: 'user.created',
          payload: { source: 'whatsapp' },
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ];

      prisma.user.findUnique = async () => mockUser;
      prisma.kycProfile.findUnique = async () => mockKyc;
      prisma.transaction.findMany = async () => mockTransactions;
      prisma.accountStatusRecord.findMany = async () => mockAccountHistory;
      prisma.auditLog.findMany = async () => mockAuditEntries;
      prisma.workflowEvent.findMany = async () => mockEvents;

      const pkg = await evidenceService.buildUserEvidencePackage({
        userId: 'usr-123',
        actingAdminId: 'admin-compliance-1',
      });

      assert.equal(pkg.exportedBy, 'admin-compliance-1');
      assert.equal(pkg.subject.userId, 'usr-123');
      assert.equal(pkg.subject.phoneNumber, '+2348012345678');
      assert.deepEqual(pkg.user, mockUser);
      assert.deepEqual(pkg.kyc, mockKyc);
      assert.deepEqual(pkg.transactions, mockTransactions);
      assert.deepEqual(pkg.accountStatusHistory, mockAccountHistory);
      assert.deepEqual(pkg.auditLog, mockAuditEntries);
      assert.deepEqual(pkg.workflowEvents, mockEvents);
      assert.ok(pkg.exportedAt);
    });
  });

  describe('exportWorkflowEventsCsv', () => {
    it('exports filtered workflow events into CSV format', async () => {
      const mockEvents = [
        {
          id: 'ev-1',
          eventType: 'payment.completed',
          aggregateType: 'Payment',
          aggregateId: 'pay-1',
          actorType: 'user',
          actorId: 'usr-1',
          payload: { amount: 50, asset: 'USDC' },
          createdAt: new Date('2026-02-01T10:00:00.000Z'),
        },
        {
          id: 'ev-2',
          eventType: 'payment.failed',
          aggregateType: 'Payment',
          aggregateId: 'pay-2',
          actorType: 'system',
          actorId: 'worker-1',
          payload: { reason: 'insufficient_funds, "retry": false' },
          createdAt: new Date('2026-02-01T11:00:00.000Z'),
        },
      ];

      let capturedWhere;
      prisma.workflowEvent.findMany = async ({ where }) => {
        capturedWhere = where;
        return mockEvents;
      };

      const csv = await evidenceService.exportWorkflowEventsCsv({
        filters: {
          eventType: 'payment.completed',
          aggregateType: 'Payment',
          aggregateId: 'pay-1',
          from: '2026-02-01T00:00:00.000Z',
          to: '2026-02-02T00:00:00.000Z',
        },
        actingAdminId: 'admin-1',
      });

      assert.equal(capturedWhere.eventType, 'payment.completed');
      assert.equal(capturedWhere.aggregateType, 'Payment');
      assert.equal(capturedWhere.aggregateId, 'pay-1');
      assert.ok(capturedWhere.createdAt.gte);
      assert.ok(capturedWhere.createdAt.lte);

      assert.match(csv, /^id,eventType,aggregateType,aggregateId,actorType,actorId,payload,createdAt\n/);
      assert.match(csv, /ev-1,payment\.completed,Payment,pay-1,user,usr-1/);
      assert.match(csv, /ev-2,payment\.failed,Payment,pay-2,system,worker-1/);
      // Tests CSV escaping of JSON payload containing quotes/commas
      assert.match(csv, /"\{""reason"":""insufficient_funds, \\""retry\\"": false""\}"/);
    });
  });

  describe('exportKycEvidenceCsv', () => {
    it('exports KYC profiles with screening data into CSV format', async () => {
      const mockProfiles = [
        {
          id: 'kyc-1',
          user: { phoneNumber: '+2348011111111', whatsappName: 'Alice' },
          provider: 'smile_id',
          tier: 1,
          status: 'verified',
          country: 'NG',
          riskScore: 5,
          sanctionsStatus: 'clear',
          custodyStatus: 'active',
          screeningResults: [
            {
              status: 'passed',
              provider: 'smile_id',
              screenedAt: new Date('2026-03-01T08:00:00.000Z'),
            },
          ],
          updatedAt: new Date('2026-03-01T09:00:00.000Z'),
          createdAt: new Date('2026-03-01T07:00:00.000Z'),
        },
      ];

      let capturedWhere;
      prisma.kycProfile.findMany = async ({ where }) => {
        capturedWhere = where;
        return mockProfiles;
      };

      const csv = await evidenceService.exportKycEvidenceCsv({
        filters: {
          status: 'verified',
          country: 'NG',
          from: '2026-03-01T00:00:00.000Z',
          to: '2026-03-02T00:00:00.000Z',
        },
        actingAdminId: 'admin-2',
      });

      assert.equal(capturedWhere.status, 'verified');
      assert.equal(capturedWhere.country, 'NG');
      assert.ok(capturedWhere.updatedAt.gte);
      assert.ok(capturedWhere.updatedAt.lte);

      assert.match(csv, /^id,phoneNumber,provider,tier,status,country,riskScore,sanctionsStatus,custodyStatus,latestScreeningStatus,latestScreeningProvider,latestScreenedAt,updatedAt,createdAt\n/);
      assert.match(csv, /kyc-1,\+2348011111111,smile_id,1,verified,NG,5,clear,active,passed,smile_id/);
    });
  });

  describe('exportAccountStatusHistoryCsv', () => {
    it('exports account status history records into CSV format', async () => {
      const mockRecords = [
        {
          id: 'ash-1',
          userId: 'usr-1',
          user: { phoneNumber: '+2348022222222' },
          status: 'deactivated',
          reason: 'User request',
          notes: 'Customer support ticket #1234',
          initiatedBy: 'support-agent-1',
          approvedBy: 'compliance-lead-1',
          approvedAt: new Date('2026-04-01T10:00:00.000Z'),
          effectiveAt: new Date('2026-04-01T10:05:00.000Z'),
          createdAt: new Date('2026-04-01T09:55:00.000Z'),
        },
      ];

      let capturedWhere;
      prisma.accountStatusRecord.findMany = async ({ where }) => {
        capturedWhere = where;
        return mockRecords;
      };

      const csv = await evidenceService.exportAccountStatusHistoryCsv({
        filters: {
          userId: 'usr-1',
          status: 'deactivated',
          from: '2026-04-01T00:00:00.000Z',
          to: '2026-04-02T00:00:00.000Z',
        },
        actingAdminId: 'admin-3',
      });

      assert.equal(capturedWhere.userId, 'usr-1');
      assert.equal(capturedWhere.status, 'deactivated');
      assert.ok(capturedWhere.createdAt.gte);
      assert.ok(capturedWhere.createdAt.lte);

      assert.match(csv, /^id,userId,phoneNumber,status,reason,notes,initiatedBy,approvedBy,approvedAt,effectiveAt,createdAt\n/);
      assert.match(csv, /ash-1,usr-1,\+2348022222222,deactivated,User request,Customer support ticket #1234,support-agent-1,compliance-lead-1/);
    });
  });

  it('exports MAX_EXPORT_ROWS with value 5000', () => {
    assert.equal(evidenceService.MAX_EXPORT_ROWS, 5000);
  });
});
