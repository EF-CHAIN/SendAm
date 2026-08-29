const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// ── Mock injection ───────────────────────────────────────────────────────

const injectMock = (relativeFromSrc, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relativeFromSrc}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

let currentProfile;
let currentApproval;
let approvalsCreated;
let auditLogs;

const prismaMock = {
  kycProfile: {
    findUnique: async ({ where }) => {
      if (!currentProfile) return null;
      if (where.id === currentProfile.id || where.userId === currentProfile.userId) {
        return { ...currentProfile };
      }
      return null;
    },
    update: async ({ where, data }) => {
      currentProfile = { ...currentProfile, ...data, id: where.id || currentProfile.id };
      return { ...currentProfile };
    },
  },
  kycApproval: {
    findUnique: async ({ where }) => {
      if (where.id === currentApproval?.id) return { ...currentApproval };
      return null;
    },
    create: async ({ data }) => {
      const record = {
        id: `approval_${approvalsCreated.length + 1}`,
        ...data,
        createdAt: new Date().toISOString(),
      };
      approvalsCreated.push(record);
      return record;
    },
    update: async ({ where, data }) => {
      currentApproval = { ...currentApproval, ...data, id: where.id };
      return { ...currentApproval };
    },
  },
  user: {
    update: async () => {},
  },
  administrator: {
    findUnique: async ({ where }) => {
      if (where.id === 'admin_2') return { id: 'admin_2', role: 'senior_compliance' };
      return null;
    },
  },
};

const auditMock = {
  writeAuditLog: async (entry) => {
    auditLogs.push(entry);
    return entry;
  },
};

injectMock('common/prisma', prismaMock);
injectMock('common/audit.service', auditMock);
injectMock('config/env', { compliance: { provider: 'smileid' } });
injectMock('utils/logger', { info: () => {}, error: () => {}, warn: () => {} });
injectMock('utils/validators', {
  canonicalizePhoneNumber: (p) => p,
  isValidPhoneNumber: () => true,
});
injectMock('utils/response', {
  sendSuccess: (res, data, message, status) => {
    res._status = status || 200;
    res._body = { success: true, data, message };
    return res;
  },
  sendError: (res, message, status) => {
    res._status = status || 500;
    res._body = { success: false, error: message };
    return res;
  },
});
// Mock modules that compliance.service imports (needs axios, money utils)
injectMock('compliance/smileId.provider', {
  submitVerification: async () => {},
  verifyCallback: () => true,
});
injectMock('utils/money', {
  assertValidAmount: (a) => a,
  add: (a) => a,
  compare: () => 0,
  formatUnits: () => '0',
  getAssetRule: () => ({ precision: 6 }),
});

const { reviewKyc, approveOverride } = require('../src/compliance/compliance.controller');

// ── Test helpers ─────────────────────────────────────────────────────────

const makeReq = (overrides = {}) => ({
  params: { id: 'profile_1' },
  body: {},
  admin: { id: 'admin_1', role: 'compliance_officer' },
  ip: '127.0.0.1',
  get: (h) => 'test-agent',
  ...overrides,
});

const makeRes = () => ({
  _status: null,
  _body: null,
});

beforeEach(() => {
  currentProfile = {
    id: 'profile_1',
    userId: 'user_1',
    status: 'pending',
    tier: 0,
    riskScore: 10,
    sanctionsStatus: 'not_screened',
    custodyStatus: 'not_reviewed',
    updatedAt: '2026-08-28T12:00:00.000Z',
    deniedReason: null,
    sanctionsScreenedAt: null,
    custodyReviewedAt: null,
  };
  currentApproval = null;
  approvalsCreated = [];
  auditLogs = [];
});

// ── Concurrency tests ────────────────────────────────────────────────────

describe('reviewKyc — concurrency', () => {
  test('rejects review when updatedAt does not match (stale profile)', async () => {
    const res = makeRes();
    await reviewKyc(
      makeReq({ body: { status: 'approved', updatedAt: '2026-08-28T11:00:00.000Z', reason: 'OK' } }),
      res,
      (err) => { throw err; },
    );
    assert.equal(res._status, 409);
    assert.ok(res._body.error.includes('modified by another operator'));
  });

  test('rejects review when updatedAt is not provided', async () => {
    const res = makeRes();
    await reviewKyc(
      makeReq({ body: { status: 'approved', reason: 'OK' } }),
      res,
      (err) => { throw err; },
    );
    assert.equal(res._status, 400);
    assert.ok(res._body.error.includes('updatedAt is required'));
  });

  test('accepts review when updatedAt matches', async () => {
    const res = makeRes();
    await reviewKyc(
      makeReq({ body: { status: 'approved', updatedAt: '2026-08-28T12:00:00.000Z', reason: 'Verified' } }),
      res,
      (err) => { throw err; },
    );
    assert.equal(res._status, 200);
    assert.equal(res._body.data.status, 'approved');
  });
});

// ── Transition matrix enforcement ─────────────────────────────────────────

describe('reviewKyc — transition matrix', () => {
  test('rejects backward transition: approved → not_started', async () => {
    currentProfile = { ...currentProfile, status: 'approved' };
    const res = makeRes();
    await reviewKyc(
      makeReq({ body: { status: 'not_started', updatedAt: currentProfile.updatedAt, reason: 'Reset' } }),
      res,
      (err) => { throw err; },
    );
    assert.equal(res._status, 400);
    assert.ok(res._body.error.includes('Invalid KYC transition'));
  });

  test('rejects invalid status value', async () => {
    const res = makeRes();
    await reviewKyc(
      makeReq({ body: { status: 'bogus', updatedAt: currentProfile.updatedAt, reason: 'X' } }),
      res,
      (err) => { throw err; },
    );
    assert.equal(res._status, 400);
    assert.ok(res._body.error.includes('Invalid KYC status'));
  });

  test('rejects tier out of bounds', async () => {
    const res = makeRes();
    await reviewKyc(
      makeReq({ body: { tier: 5, updatedAt: currentProfile.updatedAt, reason: 'X' } }),
      res,
      (err) => { throw err; },
    );
    assert.equal(res._status, 400);
    assert.ok(res._body.error.includes('Tier must be'));
  });

  test('rejects risk score out of bounds', async () => {
    const res = makeRes();
    await reviewKyc(
      makeReq({ body: { riskScore: 200, updatedAt: currentProfile.updatedAt, reason: 'X' } }),
      res,
      (err) => { throw err; },
    );
    assert.equal(res._status, 400);
    assert.ok(res._body.error.includes('Risk score must be'));
  });

  test('allows valid forward transition: pending → approved', async () => {
    const res = makeRes();
    await reviewKyc(
      makeReq({ body: { status: 'approved', updatedAt: currentProfile.updatedAt, reason: 'Verified' } }),
      res,
      (err) => { throw err; },
    );
    assert.equal(res._status, 200);
    assert.equal(res._body.data.status, 'approved');
  });
});

// ── Structured reason ────────────────────────────────────────────────────

describe('reviewKyc — reason requirement', () => {
  test('rejects when any field changes but no reason is provided', async () => {
    const res = makeRes();
    await reviewKyc(
      makeReq({ body: { status: 'approved', updatedAt: currentProfile.updatedAt } }),
      res,
      (err) => { throw err; },
    );
    assert.equal(res._status, 400);
    assert.ok(res._body.error.includes('structured reason is required'));
  });

  test('accepts when no field changes (no reason needed)', async () => {
    const res = makeRes();
    await reviewKyc(
      makeReq({ body: { updatedAt: currentProfile.updatedAt } }),
      res,
      (err) => { throw err; },
    );
    assert.equal(res._status, 200);
  });
});

// ── Maker-checker ────────────────────────────────────────────────────────

describe('reviewKyc — maker-checker', () => {
  test('creates pending approval for large tier change', async () => {
    const res = makeRes();
    await reviewKyc(
      makeReq({ body: { tier: 3, updatedAt: currentProfile.updatedAt, reason: 'VIP upgrade' } }),
      res,
      (err) => { throw err; },
    );
    assert.equal(res._status, 202);
    assert.equal(res._body.data.status, 'pending_approval');
    assert.ok(approvalsCreated.length === 1);
    assert.equal(approvalsCreated[0].status, 'pending');
    assert.equal(approvalsCreated[0].requestedBy, 'admin_1');
  });

  test('creates pending approval for large risk score change', async () => {
    const res = makeRes();
    await reviewKyc(
      makeReq({ body: { riskScore: 90, updatedAt: currentProfile.updatedAt, reason: 'Flagged' } }),
      res,
      (err) => { throw err; },
    );
    assert.equal(res._status, 202);
    assert.equal(approvalsCreated.length, 1);
  });

  test('does not create approval for single-tier step', async () => {
    const res = makeRes();
    await reviewKyc(
      makeReq({ body: { tier: 1, updatedAt: currentProfile.updatedAt, reason: 'Upgrade' } }),
      res,
      (err) => { throw err; },
    );
    assert.equal(res._status, 200);
    assert.equal(approvalsCreated.length, 0);
  });

  test('audit logs override_submitted when maker-checker triggers', async () => {
    const res = makeRes();
    await reviewKyc(
      makeReq({ body: { tier: 3, updatedAt: currentProfile.updatedAt, reason: 'VIP' } }),
      res,
      (err) => { throw err; },
    );
    const submitted = auditLogs.find(l => l.action === 'admin.compliance.override_submitted');
    assert.ok(submitted, 'Expected override_submitted audit entry');
    assert.equal(submitted.metadata.operator.id, 'admin_1');
    assert.equal(submitted.metadata.policyVersion, require('../src/compliance/kyc.transitions').POLICY_VERSION);
  });
});

// ── approveOverride ──────────────────────────────────────────────────────

describe('approveOverride', () => {
  test('rejects when approval not found', async () => {
    currentApproval = null;
    const res = makeRes();
    await approveOverride(
      makeReq({ params: { id: 'nonexistent' }, body: {} }),
      res,
      (err) => { throw err; },
    );
    assert.equal(res._status, 404);
  });

  test('rejects when approval already decided', async () => {
    currentApproval = { id: 'approval_1', status: 'approved', profileId: 'profile_1' };
    const res = makeRes();
    await approveOverride(
      makeReq({ params: { id: 'approval_1' }, body: {} }),
      res,
      (err) => { throw err; },
    );
    assert.equal(res._status, 409);
    assert.ok(res._body.error.includes('already'));
  });

  test('rejects when same operator tries to approve own override', async () => {
    currentApproval = {
      id: 'approval_1',
      status: 'pending',
      profileId: 'profile_1',
      requestedBy: 'admin_1',
      proposedChanges: { status: 'approved', tier: 1, riskScore: 5, sanctionsStatus: 'cleared', custodyStatus: 'approved', reason: 'VIP' },
    };
    const res = makeRes();
    await approveOverride(
      makeReq({ params: { id: 'approval_1' }, body: {} }),
      res,
      (err) => { throw err; },
    );
    assert.equal(res._status, 403);
    assert.ok(res._body.error.includes('cannot approve it yourself'));
  });

  test('allows different operator to approve and applies changes', async () => {
    currentApproval = {
      id: 'approval_1',
      status: 'pending',
      profileId: 'profile_1',
      requestedBy: 'admin_1',
      proposedChanges: { status: 'approved', tier: 3, riskScore: 5, sanctionsStatus: 'cleared', custodyStatus: 'approved', reason: 'VIP upgrade' },
    };
    const res = makeRes();
    await approveOverride(
      makeReq({ params: { id: 'approval_1' }, body: {}, admin: { id: 'admin_2', role: 'senior_compliance' } }),
      res,
      (err) => { throw err; },
    );
    assert.equal(res._status, 200);
    assert.equal(res._body.data.status, 'approved');
    assert.equal(res._body.data.tier, 3);

    // Approval record updated
    assert.equal(currentApproval.status, 'approved');
    assert.equal(currentApproval.approvedBy, 'admin_2');
  });

  test('audit logs override_approved with both operator identities', async () => {
    currentApproval = {
      id: 'approval_1',
      status: 'pending',
      profileId: 'profile_1',
      requestedBy: 'admin_1',
      proposedChanges: { status: 'approved', tier: 3, riskScore: 5, sanctionsStatus: 'cleared', custodyStatus: 'approved', reason: 'VIP' },
    };
    const res = makeRes();
    await approveOverride(
      makeReq({ params: { id: 'approval_1' }, body: {}, admin: { id: 'admin_2', role: 'senior_compliance' } }),
      res,
      (err) => { throw err; },
    );
    const approved = auditLogs.find(l => l.action === 'admin.compliance.override_approved');
    assert.ok(approved, 'Expected override_approved audit entry');
    assert.equal(approved.metadata.operator.id, 'admin_1');
    assert.equal(approved.metadata.secondApprover.id, 'admin_2');
    assert.equal(approved.metadata.reason, 'VIP');
  });

  test('rejects when profile state changed since override was submitted (stale)', async () => {
    currentApproval = {
      id: 'approval_1',
      status: 'pending',
      profileId: 'profile_1',
      requestedBy: 'admin_1',
      proposedChanges: { status: 'not_started', tier: 0, riskScore: 0, sanctionsStatus: 'not_screened', custodyStatus: 'not_reviewed', reason: 'Reset' },
    };
    // Profile is now in a different state that makes the proposed transition invalid
    currentProfile = { ...currentProfile, status: 'approved' };

    const res = makeRes();
    await approveOverride(
      makeReq({ params: { id: 'approval_1' }, body: {}, admin: { id: 'admin_2' } }),
      res,
      (err) => { throw err; },
    );
    assert.equal(res._status, 409);
    assert.ok(res._body.error.includes('Profile state has changed'));
  });
});

// ── Profile not found ────────────────────────────────────────────────────

describe('reviewKyc — edge cases', () => {
  test('returns 404 when profile does not exist', async () => {
    currentProfile = null;
    const res = makeRes();
    await reviewKyc(
      makeReq({ params: { id: 'nonexistent' }, body: { updatedAt: '2026-08-28T12:00:00.000Z' } }),
      res,
      (err) => { throw err; },
    );
    assert.equal(res._status, 404);
  });

  test('audit log includes old/new state snapshot', async () => {
    const res = makeRes();
    await reviewKyc(
      makeReq({ body: { status: 'approved', tier: 1, updatedAt: currentProfile.updatedAt, reason: 'Verified' } }),
      res,
      (err) => { throw err; },
    );
    const entry = auditLogs.find(l => l.action === 'admin.compliance.reviewed');
    assert.ok(entry);
    assert.equal(entry.metadata.oldState.status, 'pending');
    assert.equal(entry.metadata.oldState.tier, 0);
    assert.equal(entry.metadata.newState.status, 'approved');
    assert.equal(entry.metadata.newState.tier, 1);
    assert.equal(entry.metadata.reason, 'Verified');
    assert.equal(entry.metadata.operator.id, 'admin_1');
  });
});
