'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const supportController = require('../src/support/support.controller');

const createMockRes = () => {
  const res = {
    statusCode: 200,
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

describe('support.controller', () => {
  let req;
  let res;
  let mockPrisma;

  beforeEach(() => {
    mockPrisma = {
      user: {
        findUnique: async () => null,
      },
      wallet: {
        findUnique: async () => null,
      },
      transaction: {
        findUnique: async () => null,
      },
      supportCase: {
        create: async ({ data }) => ({ id: 'case-1', ...data }),
        findUnique: async () => null,
        findMany: async () => [],
        update: async ({ where, data }) => ({ id: where.id, ...data }),
      },
      supportCaseSnapshot: {
        create: async ({ data }) => ({ id: 'snap-1', ...data }),
      },
      supportCaseComment: {
        create: async ({ data }) => ({ id: 'comment-1', ...data }),
      },
      $transaction: async (fn) => fn(mockPrisma),
    };

    req = {
      body: {},
      params: {},
      query: {},
      user: { id: 'admin-123' },
      app: {
        locals: {
          prisma: mockPrisma,
          auditLog: async () => {},
        },
      },
    };
    res = createMockRes();
  });

  describe('createSupportCase', () => {
    it('returns 400 if category is invalid', async () => {
      req.body = {
        category: 'invalid_category',
        title: 'Issue',
        description: 'Detail',
      };

      await supportController.createSupportCase(req, res);

      assert.equal(res.statusCode, 400);
      assert.equal(res.body.success, false);
      assert.equal(res.body.message, 'Invalid case category');
    });

    it('returns 400 if title or description is missing', async () => {
      req.body = {
        category: 'payment_dispute',
        title: '',
        description: 'Detail',
      };

      await supportController.createSupportCase(req, res);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.message, 'Title and description are required');

      req.body = {
        category: 'payment_dispute',
        title: 'Dispute',
        description: '',
      };

      await supportController.createSupportCase(req, res);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.message, 'Title and description are required');
    });

    it('creates a support case with full customer context and snapshots', async () => {
      req.body = {
        userId: 'user-1',
        walletId: 'wallet-1',
        transactionId: 'tx-1',
        category: 'payment_dispute',
        title: 'Payment Delay',
        description: 'Funds not received yet',
        priority: 'high',
      };

      mockPrisma.user.findUnique = async () => ({
        id: 'user-1',
        phoneNumber: '+2348012345678',
        kycTier: 1,
        riskScore: 15,
      });
      mockPrisma.wallet.findUnique = async () => ({
        id: 'wallet-1',
        chain: 'stellar',
        publicKey: 'GABC...',
        funded: true,
      });
      mockPrisma.transaction.findUnique = async () => ({
        id: 'tx-1',
        type: 'send',
        amount: '5000.00',
        status: 'pending',
        rail: 'crypto',
      });

      let auditCalled = false;
      req.app.locals.auditLog = async (entry) => {
        auditCalled = true;
        assert.equal(entry.action, 'support.case.create');
        assert.equal(entry.actorId, 'admin-123');
      };

      await supportController.createSupportCase(req, res);

      assert.equal(res.statusCode, 201);
      assert.equal(res.body.success, true);
      assert.equal(res.body.message, 'Support case created');
      assert.equal(res.body.data.category, 'payment_dispute');
      assert.equal(res.body.data.priority, 'high');
      assert.ok(auditCalled);
    });

    it('handles unexpected errors and returns 500', async () => {
      req.body = {
        category: 'payment_dispute',
        title: 'Error Case',
        description: 'Desc',
      };
      mockPrisma.$transaction = async () => {
        throw new Error('Database connection failed');
      };

      await supportController.createSupportCase(req, res);

      assert.equal(res.statusCode, 500);
      assert.equal(res.body.success, false);
      assert.equal(res.body.message, 'Failed to create support case');
    });
  });

  describe('listSupportCases', () => {
    it('returns filtered list of support cases with pagination cursor', async () => {
      req.query = {
        userId: 'user-1',
        status: 'open',
        priority: 'high',
        assignedTo: 'admin-1',
        limit: '10',
        cursor: 'case-last',
      };

      let capturedFindManyParams = null;
      mockPrisma.supportCase.findMany = async (params) => {
        capturedFindManyParams = params;
        return [
          { id: 'case-2', title: 'Test Case', user: { id: 'user-1', phoneNumber: '+234...' }, comments: [] },
        ];
      };

      await supportController.listSupportCases(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.length, 1);
      assert.equal(capturedFindManyParams.take, 10);
      assert.equal(capturedFindManyParams.skip, 1);
      assert.deepEqual(capturedFindManyParams.cursor, { id: 'case-last' });
      assert.equal(capturedFindManyParams.where.userId, 'user-1');
      assert.equal(capturedFindManyParams.where.status, 'open');
      assert.equal(capturedFindManyParams.where.priority, 'high');
      assert.equal(capturedFindManyParams.where.assignedTo, 'admin-1');
    });

    it('returns 500 on database error', async () => {
      mockPrisma.supportCase.findMany = async () => {
        throw new Error('DB Error');
      };

      await supportController.listSupportCases(req, res);

      assert.equal(res.statusCode, 500);
      assert.equal(res.body.success, false);
      assert.equal(res.body.message, 'Failed to list support cases');
    });
  });

  describe('getSupportCase', () => {
    it('returns 404 when case is not found', async () => {
      req.params = { caseId: 'non-existent' };
      mockPrisma.supportCase.findUnique = async () => null;

      await supportController.getSupportCase(req, res);

      assert.equal(res.statusCode, 404);
      assert.equal(res.body.success, false);
      assert.equal(res.body.message, 'Case not found');
    });

    it('returns support case details with related user, comments, and snapshots', async () => {
      req.params = { caseId: 'case-1' };
      mockPrisma.supportCase.findUnique = async () => ({
        id: 'case-1',
        title: 'Dispute',
        user: { id: 'user-1', phoneNumber: '+1234', kycTier: 2 },
        comments: [{ id: 'c-1', body: 'Investigating' }],
        snapshots: [{ id: 's-1', snapshotType: 'creation' }],
      });

      await supportController.getSupportCase(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.id, 'case-1');
      assert.equal(res.body.data.comments.length, 1);
      assert.equal(res.body.data.snapshots.length, 1);
    });

    it('returns 500 on database error', async () => {
      req.params = { caseId: 'case-1' };
      mockPrisma.supportCase.findUnique = async () => {
        throw new Error('DB Error');
      };

      await supportController.getSupportCase(req, res);

      assert.equal(res.statusCode, 500);
      assert.equal(res.body.success, false);
      assert.equal(res.body.message, 'Failed to fetch support case');
    });
  });

  describe('addCaseComment', () => {
    it('returns 400 if comment body is empty or whitespace', async () => {
      req.params = { caseId: 'case-1' };
      req.body = { body: '   ' };

      await supportController.addCaseComment(req, res);

      assert.equal(res.statusCode, 400);
      assert.equal(res.body.success, false);
      assert.equal(res.body.message, 'Comment body is required');
    });

    it('returns 404 if case does not exist', async () => {
      req.params = { caseId: 'case-missing' };
      req.body = { body: 'New comment' };
      mockPrisma.supportCase.findUnique = async () => null;

      await supportController.addCaseComment(req, res);

      assert.equal(res.statusCode, 404);
      assert.equal(res.body.success, false);
      assert.equal(res.body.message, 'Case not found');
    });

    it('successfully adds comment and logs audit action', async () => {
      req.params = { caseId: 'case-1' };
      req.body = { body: 'Customer contacted via phone', actionType: 'customer_contact' };
      mockPrisma.supportCase.findUnique = async () => ({ id: 'case-1' });

      let auditCalled = false;
      req.app.locals.auditLog = async (entry) => {
        auditCalled = true;
        assert.equal(entry.action, 'support.case.comment');
        assert.equal(entry.entityId, 'case-1');
      };

      await supportController.addCaseComment(req, res);

      assert.equal(res.statusCode, 201);
      assert.equal(res.body.success, true);
      assert.equal(res.body.message, 'Comment added');
      assert.equal(res.body.data.body, 'Customer contacted via phone');
      assert.equal(res.body.data.actionType, 'customer_contact');
      assert.ok(auditCalled);
    });

    it('returns 500 on database error', async () => {
      req.params = { caseId: 'case-1' };
      req.body = { body: 'Test comment' };
      mockPrisma.supportCase.findUnique = async () => {
        throw new Error('DB Error');
      };

      await supportController.addCaseComment(req, res);

      assert.equal(res.statusCode, 500);
      assert.equal(res.body.success, false);
      assert.equal(res.body.message, 'Failed to add comment');
    });
  });

  describe('updateSupportCase', () => {
    it('returns 400 on invalid status', async () => {
      req.params = { caseId: 'case-1' };
      req.body = { status: 'invalid_status' };

      await supportController.updateSupportCase(req, res);

      assert.equal(res.statusCode, 400);
      assert.equal(res.body.message, 'Invalid case status');
    });

    it('returns 400 on invalid priority', async () => {
      req.params = { caseId: 'case-1' };
      req.body = { priority: 'ultra_urgent' };

      await supportController.updateSupportCase(req, res);

      assert.equal(res.statusCode, 400);
      assert.equal(res.body.message, 'Invalid priority');
    });

    it('returns 404 when case is not found', async () => {
      req.params = { caseId: 'missing-case' };
      req.body = { status: 'in_progress' };
      mockPrisma.supportCase.findUnique = async () => null;

      await supportController.updateSupportCase(req, res);

      assert.equal(res.statusCode, 404);
      assert.equal(res.body.message, 'Case not found');
    });

    it('updates case to resolved with resolution details and timestamps', async () => {
      req.params = { caseId: 'case-1' };
      req.body = {
        status: 'resolved',
        priority: 'high',
        assignedTo: 'admin-2',
        resolution: 'Refund processed manually',
      };
      mockPrisma.supportCase.findUnique = async () => ({
        id: 'case-1',
        status: 'in_progress',
        assignedTo: 'admin-1',
      });

      let updateData = null;
      mockPrisma.supportCase.update = async ({ where, data }) => {
        updateData = data;
        return { id: where.id, ...data };
      };

      let auditCalled = false;
      req.app.locals.auditLog = async (entry) => {
        auditCalled = true;
        assert.equal(entry.action, 'support.case.update');
        assert.equal(entry.metadata.previousStatus, 'in_progress');
        assert.equal(entry.metadata.newStatus, 'resolved');
      };

      await supportController.updateSupportCase(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.message, 'Case updated');
      assert.equal(updateData.status, 'resolved');
      assert.equal(updateData.resolvedBy, 'admin-123');
      assert.ok(updateData.resolvedAt instanceof Date);
      assert.equal(updateData.resolution, 'Refund processed manually');
      assert.ok(auditCalled);
    });

    it('updates case to closed with closedAt timestamp', async () => {
      req.params = { caseId: 'case-1' };
      req.body = { status: 'closed' };
      mockPrisma.supportCase.findUnique = async () => ({
        id: 'case-1',
        status: 'resolved',
      });

      let updateData = null;
      mockPrisma.supportCase.update = async ({ where, data }) => {
        updateData = data;
        return { id: where.id, ...data };
      };

      await supportController.updateSupportCase(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(updateData.status, 'closed');
      assert.ok(updateData.closedAt instanceof Date);
    });

    it('returns 500 on database error', async () => {
      req.params = { caseId: 'case-1' };
      req.body = { status: 'open' };
      mockPrisma.supportCase.findUnique = async () => {
        throw new Error('DB Error');
      };

      await supportController.updateSupportCase(req, res);

      assert.equal(res.statusCode, 500);
      assert.equal(res.body.success, false);
      assert.equal(res.body.message, 'Failed to update case');
    });
  });
});
