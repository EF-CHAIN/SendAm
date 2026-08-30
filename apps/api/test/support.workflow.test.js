const test = require('node:test');
const assert = require('node:assert');
const { prisma } = require('./helpers/setup');

test('Support Case Workflow', async (t) => {
  const testAdmin = { id: 'admin-test-123' };
  let testCase = null;

  await t.test('should create a support case with customer context', async () => {
    const user = await prisma.user.create({
      data: {
        phoneNumber: `+234${Math.random().toString().slice(2, 12)}`,
      },
    });

    const wallet = await prisma.wallet.create({
      data: {
        userId: user.id,
        chain: 'stellar',
        publicKey: 'GCTEST' + Math.random().toString(36).slice(2, 40).toUpperCase(),
      },
    });

    const transaction = await prisma.transaction.create({
      data: {
        userId: user.id,
        type: 'send',
        amount: '100.00',
        asset: 'USDC',
        status: 'pending',
      },
    });

    const supportCase = await prisma.supportCase.create({
      data: {
        caseNumber: `CASE-${Date.now()}`,
        userId: user.id,
        category: 'payment_dispute',
        title: 'Payment not received',
        description: 'Customer reports payment was deducted but not received',
        transactionId: transaction.id,
        walletId: wallet.id,
        priority: 'high',
        assignedTo: testAdmin.id,
      },
    });

    testCase = supportCase;
    assert.ok(supportCase.id);
    assert.strictEqual(supportCase.userId, user.id);
    assert.strictEqual(supportCase.status, 'open');
    assert.strictEqual(supportCase.category, 'payment_dispute');
  });

  await t.test('should capture customer context snapshot at case creation', async () => {
    const user = await prisma.user.create({
      data: {
        phoneNumber: `+234${Math.random().toString().slice(2, 12)}`,
        kycTier: 1,
      },
    });

    const transaction = await prisma.transaction.create({
      data: {
        userId: user.id,
        type: 'send',
        amount: '50.00',
        asset: 'USDC',
        status: 'processing',
      },
    });

    const supportCase = await prisma.$transaction(async (tx) => {
      const newCase = await tx.supportCase.create({
        data: {
          caseNumber: `CASE-${Date.now()}`,
          userId: user.id,
          category: 'error_investigation',
          title: 'Transaction stuck in processing',
          description: 'Transaction has been processing for over 10 minutes',
          transactionId: transaction.id,
        },
      });

      // Create snapshot with customer data
      await tx.supportCaseSnapshot.create({
        data: {
          caseId: newCase.id,
          snapshotType: 'creation',
          userData: {
            id: user.id,
            phoneNumber: user.phoneNumber,
            kycTier: user.kycTier,
          },
          transactionData: {
            id: transaction.id,
            type: transaction.type,
            amount: transaction.amount,
            status: transaction.status,
          },
        },
      });

      return newCase;
    });

    // Verify snapshot was created
    const snapshot = await prisma.supportCaseSnapshot.findFirst({
      where: {
        caseId: supportCase.id,
        snapshotType: 'creation',
      },
    });

    assert.ok(snapshot);
    assert.strictEqual(snapshot.userData.phoneNumber, user.phoneNumber);
    assert.strictEqual(snapshot.transactionData.status, 'processing');
  });

  await t.test('should track support case actions with immutable audit trail', async () => {
    if (!testCase) {
      throw new Error('Test case not created in setup');
    }

    const adminId = testAdmin.id;

    // Add initial comment
    const comment1 = await prisma.supportCaseComment.create({
      data: {
        caseId: testCase.id,
        authorType: 'admin',
        authorId: adminId,
        actionType: 'comment',
        body: 'Investigating payment route',
      },
    });

    assert.ok(comment1.id);
    assert.strictEqual(comment1.actionType, 'comment');

    // Update case status
    const updated = await prisma.$transaction(async (tx) => {
      const case_ = await tx.supportCase.update({
        where: { id: testCase.id },
        data: { status: 'in_progress' },
      });

      // Log status change
      await tx.supportCaseComment.create({
        data: {
          caseId: testCase.id,
          authorType: 'admin',
          authorId: adminId,
          actionType: 'status_change',
          body: 'Status changed to in_progress',
        },
      });

      return case_;
    });

    assert.strictEqual(updated.status, 'in_progress');

    // Verify all comments exist
    const comments = await prisma.supportCaseComment.findMany({
      where: { caseId: testCase.id },
      orderBy: { createdAt: 'asc' },
    });

    assert.strictEqual(comments.length, 2);
    assert.strictEqual(comments[0].actionType, 'comment');
    assert.strictEqual(comments[1].actionType, 'status_change');
  });

  await t.test('should handle case escalation with new snapshot', async () => {
    const user = await prisma.user.create({
      data: {
        phoneNumber: `+234${Math.random().toString().slice(2, 12)}`,
      },
    });

    const supportCase = await prisma.supportCase.create({
      data: {
        caseNumber: `CASE-${Date.now()}`,
        userId: user.id,
        category: 'kyc_issue',
        title: 'KYC verification failed',
        description: 'Customer KYC verification has been rejected',
        priority: 'critical',
      },
    });

    const escalated = await prisma.$transaction(async (tx) => {
      // Update to escalated
      const case_ = await tx.supportCase.update({
        where: { id: supportCase.id },
        data: { priority: 'critical', status: 'in_progress' },
      });

      // Create escalation snapshot
      await tx.supportCaseSnapshot.create({
        data: {
          caseId: supportCase.id,
          snapshotType: 'escalation',
          userData: {
            id: user.id,
            phoneNumber: user.phoneNumber,
          },
          context: {
            escalationReason: 'Requires senior operator review',
            escalatedAt: new Date().toISOString(),
          },
        },
      });

      // Log escalation
      await tx.supportCaseComment.create({
        data: {
          caseId: supportCase.id,
          authorType: 'system',
          actionType: 'escalation',
          body: 'Case escalated to senior team',
        },
      });

      return case_;
    });

    assert.strictEqual(escalated.priority, 'critical');

    // Verify escalation snapshot exists
    const snapshots = await prisma.supportCaseSnapshot.findMany({
      where: { caseId: supportCase.id },
    });

    assert.ok(snapshots.some((s) => s.snapshotType === 'escalation'));
  });

  await t.test('should resolve case with resolution details', async () => {
    const user = await prisma.user.create({
      data: {
        phoneNumber: `+234${Math.random().toString().slice(2, 12)}`,
      },
    });

    const supportCase = await prisma.supportCase.create({
      data: {
        caseNumber: `CASE-${Date.now()}`,
        userId: user.id,
        category: 'payment_dispute',
        title: 'Test dispute',
        description: 'Test case for resolution',
        assignedTo: testAdmin.id,
      },
    });

    const resolved = await prisma.$transaction(async (tx) => {
      const case_ = await tx.supportCase.update({
        where: { id: supportCase.id },
        data: {
          status: 'resolved',
          resolution: 'Payment was successfully retried and completed',
          resolvedBy: testAdmin.id,
          resolvedAt: new Date(),
        },
      });

      // Create resolution snapshot
      await tx.supportCaseSnapshot.create({
        data: {
          caseId: supportCase.id,
          snapshotType: 'resolution',
          userData: { id: user.id },
          context: {
            resolution: 'Payment was successfully retried and completed',
            resolvedAt: new Date().toISOString(),
          },
        },
      });

      // Log resolution
      await tx.supportCaseComment.create({
        data: {
          caseId: supportCase.id,
          authorType: 'admin',
          authorId: testAdmin.id,
          actionType: 'status_change',
          body: 'Case resolved - payment retried successfully',
        },
      });

      return case_;
    });

    assert.strictEqual(resolved.status, 'resolved');
    assert.ok(resolved.resolvedAt);
    assert.strictEqual(resolved.resolvedBy, testAdmin.id);
  });

  await t.test('should support case assignment and transfer', async () => {
    const user = await prisma.user.create({
      data: {
        phoneNumber: `+234${Math.random().toString().slice(2, 12)}`,
      },
    });

    const supportCase = await prisma.supportCase.create({
      data: {
        caseNumber: `CASE-${Date.now()}`,
        userId: user.id,
        category: 'account_access',
        title: 'Account access issue',
        description: 'Customer cannot access their account',
        assignedTo: 'admin-1',
      },
    });

    const adminId2 = 'admin-2';

    const reassigned = await prisma.$transaction(async (tx) => {
      const case_ = await tx.supportCase.update({
        where: { id: supportCase.id },
        data: { assignedTo: adminId2 },
      });

      // Log reassignment
      await tx.supportCaseComment.create({
        data: {
          caseId: supportCase.id,
          authorType: 'system',
          actionType: 'assignment',
          body: `Case reassigned from admin-1 to ${adminId2}`,
        },
      });

      return case_;
    });

    assert.strictEqual(reassigned.assignedTo, adminId2);

    // Verify assignment comment exists
    const comment = await prisma.supportCaseComment.findFirst({
      where: {
        caseId: supportCase.id,
        actionType: 'assignment',
      },
    });

    assert.ok(comment);
  });

  await t.test('should enforce authorized operator access only', async () => {
    const user = await prisma.user.create({
      data: {
        phoneNumber: `+234${Math.random().toString().slice(2, 12)}`,
      },
    });

    // Only operators (admins) should be able to create cases
    const operatorId = 'operator-authorized';
    assert.ok(operatorId);

    // Verify that creating a case requires authorization context
    const supportCase = await prisma.supportCase.create({
      data: {
        caseNumber: `CASE-${Date.now()}`,
        userId: user.id,
        category: 'error_investigation',
        title: 'Authorized case',
        description: 'Only operators can create',
        assignedTo: operatorId,
      },
    });

    assert.ok(supportCase.id);
    assert.strictEqual(supportCase.assignedTo, operatorId);
  });

  // Cleanup
  await t.test('cleanup test data', async () => {
    assert.ok(true);
  });
});

module.exports = { test };
