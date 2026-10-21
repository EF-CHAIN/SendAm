const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const injectMock = (relativeFromSrc, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relativeFromSrc}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

let loggedErrors = [];
injectMock('utils/logger', {
  error: (msg, err) => {
    loggedErrors.push({ msg, err });
  },
  info: () => {},
  warn: () => {},
  debug: () => {},
});

// Load the controller under test
const supportController = require('../src/support/support.controller');

const createMockRes = () => {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
  };
  return res;
};

describe('support.controller.js unit tests', () => {
  let mockPrisma;
  let auditLogs;
  let users;
  let wallets;
  let transactions;
  let supportCases;
  let snapshots;
  let comments;

  beforeEach(() => {
    loggedErrors = [];
    auditLogs = [];
    users = new Map();
    wallets = new Map();
    transactions = new Map();
    supportCases = new Map();
    snapshots = [];
    comments = [];

    mockPrisma = {
      user: {
        findUnique: async ({ where }) => users.get(where.id) || null,
      },
      wallet: {
        findUnique: async ({ where }) => wallets.get(where.id) || null,
      },
      transaction: {
        findUnique: async ({ where }) => transactions.get(where.id) || null,
      },
      supportCase: {
        create: async ({ data }) => {
          const id = `case_${supportCases.size + 1}`;
          const record = { id, status: 'open', createdAt: new Date(), ...data };
          supportCases.set(id, record);
          return record;
        },
        findMany: async ({ where = {}, take, skip, cursor, orderBy, include }) => {
          let list = Array.from(supportCases.values()).filter((c) => {
            if (where.userId && c.userId !== where.userId) return false;
            if (where.status && c.status !== where.status) return false;
            if (where.priority && c.priority !== where.priority) return false;
            if (where.assignedTo && c.assignedTo !== where.assignedTo) return false;
            return true;
          });
          if (orderBy?.createdAt === 'desc') {
            list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
          }
          if (cursor?.id) {
            const idx = list.findIndex((c) => c.id === cursor.id);
            if (idx !== -1) {
              list = list.slice(idx + (skip || 0));
            }
          }
          if (take) {
            list = list.slice(0, take);
          }
          if (include?.user) {
            list = list.map((c) => {
              const u = users.get(c.userId);
              return {
                ...c,
                user: u ? { id: u.id, phoneNumber: u.phoneNumber } : null,
              };
            });
          }
          if (include?.comments) {
            list = list.map((c) => {
              const cList = comments.filter((cm) => cm.caseId === c.id);
              return {
                ...c,
                comments: cList.slice(0, include.comments.take || 5),
              };
            });
          }
          return list;
        },
        findUnique: async ({ where, include }) => {
          const c = supportCases.get(where.id);
          if (!c) return null;
          let result = { ...c };
          if (include?.user) {
            const u = users.get(c.userId);
            result.user = u ? { id: u.id, phoneNumber: u.phoneNumber, kycTier: u.kycTier } : null;
          }
          if (include?.comments) {
            result.comments = comments.filter((cm) => cm.caseId === c.id);
          }
          if (include?.snapshots) {
            result.snapshots = snapshots.filter((sn) => sn.caseId === c.id);
          }
          return result;
        },
        update: async ({ where, data }) => {
          const c = supportCases.get(where.id);
          if (!c) throw new Error('Case not found');
          const updated = { ...c, ...data };
          supportCases.set(where.id, updated);
          return updated;
        },
      },
      supportCaseSnapshot: {
        create: async ({ data }) => {
          const record = { id: `snap_${snapshots.length + 1}`, createdAt: new Date(), ...data };
          snapshots.push(record);
          return record;
        },
      },
      supportCaseComment: {
        create: async ({ data }) => {
          const record = { id: `comm_${comments.length + 1}`, createdAt: new Date(), ...data };
          comments.push(record);
          return record;
        },
      },
      $transaction: async (fn) => fn(mockPrisma),
    };
  });

  const createReq = (overrides = {}) => ({
    body: {},
    query: {},
    params: {},
    user: { id: 'admin_123', role: 'admin' },
    app: {
      locals: {
        prisma: mockPrisma,
        auditLog: async (log) => {
          auditLogs.push(log);
        },
      },
    },
    ...overrides,
  });

  describe('createSupportCase', () => {
    test('successfully creates a support case with context snapshots, comment, and audit log', async () => {
      users.set('user_1', { id: 'user_1', phoneNumber: '+2348000000000', kycTier: 1, riskScore: 15 });
      wallets.set('wallet_1', { id: 'wallet_1', chain: 'stellar', publicKey: 'GB123', funded: true });
      transactions.set('tx_1', { id: 'tx_1', type: 'send', amount: '100.00', status: 'pending', rail: 'stellar' });

      const req = createReq({
        body: {
          userId: 'user_1',
          walletId: 'wallet_1',
          transactionId: 'tx_1',
          category: 'payment_dispute',
          title: 'Missing payment',
          description: 'Payment was deducted but recipient did not receive',
          priority: 'high',
        },
      });
      const res = createMockRes();

      await supportController.createSupportCase(req, res);

      assert.equal(res.statusCode, 201);
      assert.equal(res.body.success, true);
      assert.equal(res.body.message, 'Support case created');
      assert.ok(res.body.data.caseNumber.startsWith('CASE-'));
      assert.equal(res.body.data.priority, 'high');
      assert.equal(res.body.data.assignedTo, 'admin_123');

      // Verify snapshots
      assert.equal(snapshots.length, 1);
      assert.equal(snapshots[0].snapshotType, 'creation');
      assert.equal(snapshots[0].userData.id, 'user_1');
      assert.equal(snapshots[0].walletData.id, 'wallet_1');
      assert.equal(snapshots[0].transactionData.id, 'tx_1');

      // Verify initial comment
      assert.equal(comments.length, 1);
      assert.equal(comments[0].actionType, 'comment');
      assert.equal(comments[0].authorId, 'admin_123');

      // Verify audit log
      assert.equal(auditLogs.length, 1);
      assert.equal(auditLogs[0].action, 'support.case.create');
      assert.equal(auditLogs[0].actorId, 'admin_123');
    });

    test('creates support case when user, wallet, and transaction are omitted', async () => {
      const req = createReq({
        body: {
          category: 'other',
          title: 'General inquiry',
          description: 'How to use payment features',
        },
      });
      const res = createMockRes();

      await supportController.createSupportCase(req, res);

      assert.equal(res.statusCode, 201);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.priority, 'normal');
      assert.deepEqual(snapshots[0].userData, {});
      assert.equal(snapshots[0].walletData, null);
      assert.equal(snapshots[0].transactionData, null);
    });

    test('returns 400 when category is invalid', async () => {
      const req = createReq({
        body: {
          category: 'unsupported_category',
          title: 'Test',
          description: 'Details',
        },
      });
      const res = createMockRes();

      await supportController.createSupportCase(req, res);

      assert.equal(res.statusCode, 400);
      assert.equal(res.body.success, false);
      assert.equal(res.body.message, 'Invalid case category');
    });

    test('returns 400 when title or description is missing', async () => {
      const reqNoTitle = createReq({
        body: { category: 'kyc_issue', description: 'Some description' },
      });
      const res1 = createMockRes();
      await supportController.createSupportCase(reqNoTitle, res1);
      assert.equal(res1.statusCode, 400);
      assert.equal(res1.body.message, 'Title and description are required');

      const reqNoDesc = createReq({
        body: { category: 'kyc_issue', title: 'Some title' },
      });
      const res2 = createMockRes();
      await supportController.createSupportCase(reqNoDesc, res2);
      assert.equal(res2.statusCode, 400);
      assert.equal(res2.body.message, 'Title and description are required');
    });

    test('returns 500 when transaction or database fails', async () => {
      mockPrisma.$transaction = async () => {
        throw new Error('DB write failure');
      };
      const req = createReq({
        body: {
          category: 'account_access',
          title: 'Lockout',
          description: 'Cannot login',
        },
      });
      const res = createMockRes();

      await supportController.createSupportCase(req, res);

      assert.equal(res.statusCode, 500);
      assert.equal(res.body.success, false);
      assert.equal(res.body.message, 'Failed to create support case');
      assert.equal(loggedErrors.length, 1);
    });
  });

  describe('listSupportCases', () => {
    beforeEach(() => {
      users.set('user_1', { id: 'user_1', phoneNumber: '+2348000000000' });
      supportCases.set('case_1', {
        id: 'case_1',
        caseNumber: 'CASE-1',
        userId: 'user_1',
        status: 'open',
        priority: 'high',
        assignedTo: 'admin_1',
        createdAt: new Date('2026-09-01'),
      });
      supportCases.set('case_2', {
        id: 'case_2',
        caseNumber: 'CASE-2',
        userId: 'user_2',
        status: 'resolved',
        priority: 'normal',
        assignedTo: 'admin_2',
        createdAt: new Date('2026-09-02'),
      });
    });

    test('returns filtered cases with status, user and comments', async () => {
      const req = createReq({
        query: { status: 'open', priority: 'high', assignedTo: 'admin_1', userId: 'user_1' },
      });
      const res = createMockRes();

      await supportController.listSupportCases(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.length, 1);
      assert.equal(res.body.data[0].id, 'case_1');
      assert.equal(res.body.data[0].user.phoneNumber, '+2348000000000');
    });

    test('returns 500 when listing query throws', async () => {
      mockPrisma.supportCase.findMany = async () => {
        throw new Error('Prisma disconnect');
      };
      const req = createReq();
      const res = createMockRes();

      await supportController.listSupportCases(req, res);

      assert.equal(res.statusCode, 500);
      assert.equal(res.body.success, false);
      assert.equal(res.body.message, 'Failed to list support cases');
      assert.equal(loggedErrors.length, 1);
    });
  });

  describe('getSupportCase', () => {
    beforeEach(() => {
      users.set('user_1', { id: 'user_1', phoneNumber: '+2348000000000', kycTier: 2 });
      supportCases.set('case_1', {
        id: 'case_1',
        caseNumber: 'CASE-1',
        userId: 'user_1',
        status: 'open',
      });
      comments.push({ id: 'comm_1', caseId: 'case_1', body: 'Comment 1', createdAt: new Date() });
      snapshots.push({ id: 'snap_1', caseId: 'case_1', snapshotType: 'creation', createdAt: new Date() });
    });

    test('returns 200 and support case details with relations', async () => {
      const req = createReq({ params: { caseId: 'case_1' } });
      const res = createMockRes();

      await supportController.getSupportCase(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.id, 'case_1');
      assert.equal(res.body.data.user.kycTier, 2);
      assert.equal(res.body.data.comments.length, 1);
      assert.equal(res.body.data.snapshots.length, 1);
    });

    test('returns 404 when case is not found', async () => {
      const req = createReq({ params: { caseId: 'non_existent_case' } });
      const res = createMockRes();

      await supportController.getSupportCase(req, res);

      assert.equal(res.statusCode, 404);
      assert.equal(res.body.success, false);
      assert.equal(res.body.message, 'Case not found');
    });

    test('returns 500 when database error occurs', async () => {
      mockPrisma.supportCase.findUnique = async () => {
        throw new Error('Database read failed');
      };
      const req = createReq({ params: { caseId: 'case_1' } });
      const res = createMockRes();

      await supportController.getSupportCase(req, res);

      assert.equal(res.statusCode, 500);
      assert.equal(res.body.success, false);
      assert.equal(res.body.message, 'Failed to fetch support case');
    });
  });

  describe('addCaseComment', () => {
    beforeEach(() => {
      supportCases.set('case_1', { id: 'case_1', status: 'open' });
    });

    test('successfully adds a comment and records audit log', async () => {
      const req = createReq({
        params: { caseId: 'case_1' },
        body: { body: 'Investigating payment details with gateway', actionType: 'note' },
      });
      const res = createMockRes();

      await supportController.addCaseComment(req, res);

      assert.equal(res.statusCode, 201);
      assert.equal(res.body.success, true);
      assert.equal(res.body.message, 'Comment added');
      assert.equal(res.body.data.body, 'Investigating payment details with gateway');
      assert.equal(res.body.data.actionType, 'note');
      assert.equal(res.body.data.authorId, 'admin_123');

      assert.equal(auditLogs.length, 1);
      assert.equal(auditLogs[0].action, 'support.case.comment');
      assert.equal(auditLogs[0].entityId, 'case_1');
    });

    test('returns 400 when comment body is missing or empty', async () => {
      const reqEmpty = createReq({
        params: { caseId: 'case_1' },
        body: { body: '   ' },
      });
      const res = createMockRes();

      await supportController.addCaseComment(reqEmpty, res);

      assert.equal(res.statusCode, 400);
      assert.equal(res.body.success, false);
      assert.equal(res.body.message, 'Comment body is required');
    });

    test('returns 404 when target case does not exist', async () => {
      const req = createReq({
        params: { caseId: 'case_missing' },
        body: { body: 'Valid comment text' },
      });
      const res = createMockRes();

      await supportController.addCaseComment(req, res);

      assert.equal(res.statusCode, 404);
      assert.equal(res.body.success, false);
      assert.equal(res.body.message, 'Case not found');
    });

    test('returns 500 when error occurs during creation', async () => {
      mockPrisma.supportCaseComment.create = async () => {
        throw new Error('Comment insert error');
      };
      const req = createReq({
        params: { caseId: 'case_1' },
        body: { body: 'Valid comment' },
      });
      const res = createMockRes();

      await supportController.addCaseComment(req, res);

      assert.equal(res.statusCode, 500);
      assert.equal(res.body.success, false);
      assert.equal(res.body.message, 'Failed to add comment');
    });
  });

  describe('updateSupportCase', () => {
    beforeEach(() => {
      supportCases.set('case_1', {
        id: 'case_1',
        status: 'open',
        priority: 'normal',
        assignedTo: 'admin_1',
      });
    });

    test('successfully updates status to resolved with resolution text and audit log', async () => {
      const req = createReq({
        params: { caseId: 'case_1' },
        body: {
          status: 'resolved',
          priority: 'low',
          assignedTo: 'admin_123',
          resolution: 'Payment re-routed successfully',
        },
      });
      const res = createMockRes();

      await supportController.updateSupportCase(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.message, 'Case updated');
      assert.equal(res.body.data.status, 'resolved');
      assert.equal(res.body.data.resolution, 'Payment re-routed successfully');
      assert.equal(res.body.data.resolvedBy, 'admin_123');
      assert.ok(res.body.data.resolvedAt instanceof Date);

      assert.equal(auditLogs.length, 1);
      assert.equal(auditLogs[0].action, 'support.case.update');
      assert.equal(auditLogs[0].metadata.previousStatus, 'open');
      assert.equal(auditLogs[0].metadata.newStatus, 'resolved');
    });

    test('successfully updates status to closed with closedAt timestamp', async () => {
      const req = createReq({
        params: { caseId: 'case_1' },
        body: { status: 'closed' },
      });
      const res = createMockRes();

      await supportController.updateSupportCase(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.data.status, 'closed');
      assert.ok(res.body.data.closedAt instanceof Date);
    });

    test('returns 400 when status is invalid', async () => {
      const req = createReq({
        params: { caseId: 'case_1' },
        body: { status: 'bogus_status' },
      });
      const res = createMockRes();

      await supportController.updateSupportCase(req, res);

      assert.equal(res.statusCode, 400);
      assert.equal(res.body.success, false);
      assert.equal(res.body.message, 'Invalid case status');
    });

    test('returns 400 when priority is invalid', async () => {
      const req = createReq({
        params: { caseId: 'case_1' },
        body: { priority: 'ultra_high' },
      });
      const res = createMockRes();

      await supportController.updateSupportCase(req, res);

      assert.equal(res.statusCode, 400);
      assert.equal(res.body.success, false);
      assert.equal(res.body.message, 'Invalid priority');
    });

    test('returns 404 when case to update does not exist', async () => {
      const req = createReq({
        params: { caseId: 'case_missing' },
        body: { status: 'in_progress' },
      });
      const res = createMockRes();

      await supportController.updateSupportCase(req, res);

      assert.equal(res.statusCode, 404);
      assert.equal(res.body.success, false);
      assert.equal(res.body.message, 'Case not found');
    });

    test('returns 500 when update fails in database', async () => {
      mockPrisma.supportCase.update = async () => {
        throw new Error('Update conflict');
      };
      const req = createReq({
        params: { caseId: 'case_1' },
        body: { status: 'in_progress' },
      });
      const res = createMockRes();

      await supportController.updateSupportCase(req, res);

      assert.equal(res.statusCode, 500);
      assert.equal(res.body.success, false);
      assert.equal(res.body.message, 'Failed to update case');
    });
  });
});
