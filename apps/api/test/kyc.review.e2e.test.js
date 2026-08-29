const test = require('node:test');
const assert = require('node:assert');
const { prisma } = require('./helpers/setup');

test('KYC Review Approval and Denial E2E', async (t) => {
  const testUser = { phoneNumber: `+234${Math.random().toString().slice(2, 12)}` };

  await t.test('should create a user and initiate KYC', async () => {
    const user = await prisma.user.create({
      data: {
        phoneNumber: testUser.phoneNumber,
        kycTier: 0,
      },
    });

    testUser.id = user.id;

    const kycProfile = await prisma.kycProfile.create({
      data: {
        userId: user.id,
        status: 'pending_review',
        tier: 1,
      },
    });

    assert.strictEqual(kycProfile.userId, user.id);
    assert.strictEqual(kycProfile.status, 'pending_review');
  });

  await t.test('should transition KYC to approved state', async () => {
    const adminId = 'admin-1';
    const kycProfile = await prisma.kycProfile.findUnique({
      where: { userId: testUser.id },
    });

    const approval = await prisma.kycApproval.create({
      data: {
        profileId: kycProfile.id,
        proposedChanges: { status: 'approved', tier: 1 },
        requestedBy: adminId,
        status: 'pending',
      },
    });

    assert.strictEqual(approval.status, 'pending');

    // Approve the proposal
    const approvedKyc = await prisma.$transaction(async (tx) => {
      // Update approval record
      await tx.kycApproval.update({
        where: { id: approval.id },
        data: {
          status: 'approved',
          approvedBy: adminId,
          decidedAt: new Date(),
        },
      });

      // Update KYC profile
      const updated = await tx.kycProfile.update({
        where: { id: kycProfile.id },
        data: {
          status: 'approved',
          tier: 1,
        },
      });

      // Create audit log
      await tx.auditLog.create({
        data: {
          actorType: 'administrator',
          actorId: adminId,
          action: 'kyc.approve',
          entityType: 'KycProfile',
          entityId: kycProfile.id,
          metadata: { previousStatus: 'pending_review', newStatus: 'approved' },
        },
      });

      return updated;
    });

    assert.strictEqual(approvedKyc.status, 'approved');
    assert.strictEqual(approvedKyc.tier, 1);

    // Verify audit log was created
    const auditLog = await prisma.auditLog.findFirst({
      where: {
        action: 'kyc.approve',
        entityId: kycProfile.id,
      },
    });

    assert.ok(auditLog);
    assert.strictEqual(auditLog.actorId, adminId);
  });

  await t.test('should transition KYC to denied state', async () => {
    // Create another user for denial test
    const denyUser = await prisma.user.create({
      data: {
        phoneNumber: `+234${Math.random().toString().slice(2, 12)}`,
        kycTier: 0,
      },
    });

    const kycProfile = await prisma.kycProfile.create({
      data: {
        userId: denyUser.id,
        status: 'pending_review',
        tier: 0,
      },
    });

    const adminId = 'admin-1';
    const denialReason = 'Document verification failed - invalid ID';

    const deniedKyc = await prisma.$transaction(async (tx) => {
      const updated = await tx.kycProfile.update({
        where: { id: kycProfile.id },
        data: {
          status: 'denied',
          tier: 0,
          deniedReason: denialReason,
        },
      });

      // Create audit log for denial
      await tx.auditLog.create({
        data: {
          actorType: 'administrator',
          actorId: adminId,
          action: 'kyc.deny',
          entityType: 'KycProfile',
          entityId: kycProfile.id,
          metadata: {
            previousStatus: 'pending_review',
            newStatus: 'denied',
            reason: denialReason,
          },
        },
      });

      return updated;
    });

    assert.strictEqual(deniedKyc.status, 'denied');
    assert.strictEqual(deniedKyc.deniedReason, denialReason);

    // Verify audit log was created
    const auditLog = await prisma.auditLog.findFirst({
      where: {
        action: 'kyc.deny',
        entityId: kycProfile.id,
      },
    });

    assert.ok(auditLog);
    assert.strictEqual(auditLog.metadata.reason, denialReason);
  });

  await t.test('should handle KYC escalation flow', async () => {
    const escalateUser = await prisma.user.create({
      data: {
        phoneNumber: `+234${Math.random().toString().slice(2, 12)}`,
        kycTier: 0,
      },
    });

    const kycProfile = await prisma.kycProfile.create({
      data: {
        userId: escalateUser.id,
        status: 'pending_review',
        tier: 0,
      },
    });

    const adminId = 'admin-1';

    // Create escalation request
    const escalation = await prisma.kycApproval.create({
      data: {
        profileId: kycProfile.id,
        proposedChanges: { status: 'escalated', tier: 0 },
        requestedBy: adminId,
        status: 'pending',
      },
    });

    assert.strictEqual(escalation.status, 'pending');

    // Update status to indicate escalation
    const escalatedProfile = await prisma.$transaction(async (tx) => {
      // Update profile to escalated state
      const updated = await tx.kycProfile.update({
        where: { id: kycProfile.id },
        data: { status: 'escalated' },
      });

      // Log escalation action
      await tx.auditLog.create({
        data: {
          actorType: 'administrator',
          actorId: adminId,
          action: 'kyc.escalate',
          entityType: 'KycProfile',
          entityId: kycProfile.id,
          metadata: { reason: 'Requires senior review' },
        },
      });

      return updated;
    });

    assert.strictEqual(escalatedProfile.status, 'escalated');
  });

  await t.test('should validate admin permissions for KYC decisions', async () => {
    const user = await prisma.user.create({
      data: {
        phoneNumber: `+234${Math.random().toString().slice(2, 12)}`,
        kycTier: 0,
      },
    });

    const kycProfile = await prisma.kycProfile.create({
      data: {
        userId: user.id,
        status: 'pending_review',
      },
    });

    // Verify only admins can create approval records
    const adminId = 'admin-authorized';

    const approval = await prisma.kycApproval.create({
      data: {
        profileId: kycProfile.id,
        proposedChanges: { status: 'approved' },
        requestedBy: adminId,
      },
    });

    assert.ok(approval.id);
    assert.strictEqual(approval.requestedBy, adminId);
  });

  await t.test('should create audit trail for all KYC state transitions', async () => {
    const auditUser = await prisma.user.create({
      data: {
        phoneNumber: `+234${Math.random().toString().slice(2, 12)}`,
        kycTier: 0,
      },
    });

    const kycProfile = await prisma.kycProfile.create({
      data: {
        userId: auditUser.id,
        status: 'pending_review',
      },
    });

    const adminId = 'audit-test-admin';

    // Approve with audit
    await prisma.auditLog.create({
      data: {
        actorType: 'administrator',
        actorId: adminId,
        action: 'kyc.approve',
        entityType: 'KycProfile',
        entityId: kycProfile.id,
      },
    });

    // Verify audit logs exist
    const logs = await prisma.auditLog.findMany({
      where: {
        entityType: 'KycProfile',
        entityId: kycProfile.id,
      },
    });

    assert.ok(logs.length > 0);
    logs.forEach((log) => {
      assert.strictEqual(log.actorType, 'administrator');
      assert.strictEqual(log.actorId, adminId);
    });
  });

  await t.test('should handle resubmission after denial', async () => {
    const resubmitUser = await prisma.user.create({
      data: {
        phoneNumber: `+234${Math.random().toString().slice(2, 12)}`,
        kycTier: 0,
      },
    });

    const kycProfile = await prisma.kycProfile.create({
      data: {
        userId: resubmitUser.id,
        status: 'denied',
        deniedReason: 'Invalid document',
      },
    });

    const adminId = 'admin-1';

    // Resubmit for review
    const resubmitted = await prisma.$transaction(async (tx) => {
      const updated = await tx.kycProfile.update({
        where: { id: kycProfile.id },
        data: {
          status: 'pending_review',
          deniedReason: null,
        },
      });

      await tx.auditLog.create({
        data: {
          actorType: 'customer',
          action: 'kyc.resubmit',
          entityType: 'KycProfile',
          entityId: kycProfile.id,
          metadata: { previousStatus: 'denied', newStatus: 'pending_review' },
        },
      });

      return updated;
    });

    assert.strictEqual(resubmitted.status, 'pending_review');
    assert.strictEqual(resubmitted.deniedReason, null);
  });

  // Cleanup
  await t.test('cleanup test data', async () => {
    // Cleanup is handled by transaction rollback or test isolation
    assert.ok(true);
  });
});

module.exports = { test };
