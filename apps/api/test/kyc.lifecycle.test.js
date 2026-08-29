const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const injectMock = (relativeFromSrc, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relativeFromSrc}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

const profile = {
  id: 'profile_1', userId: 'user_1', status: 'not_started', provider: 'smileid',
  providerReference: null, tier: 0, riskScore: 0,
};
let currentProfile;
let submitted;
let signatureValid;
let duplicate;

const tx = {
  kycProfile: {
    findFirst: async () => currentProfile,
    update: async ({ data }) => { currentProfile = { ...currentProfile, ...data }; return currentProfile; },
  },
  kycWebhookEvent: {
    create: async () => {
      if (duplicate) {
        const error = new Error('duplicate');
        error.code = 'P2002';
        throw error;
      }
    },
  },
  user: { update: async () => {} },
  auditLog: { create: async () => {} },
};
const prisma = {
  kycProfile: {
    findUnique: async ({ where }) => (where.userId || where.id ? currentProfile : null),
    create: async () => currentProfile,
    update: tx.kycProfile.update,
  },
  $transaction: async (fn) => fn(tx),
};
const provider = {
  submitVerification: async (request) => { submitted = request; },
  verifyCallback: () => signatureValid,
};

injectMock('common/prisma', prisma);
injectMock('config/env', {
  compliance: {
    provider: 'smileid',
    policyCurrency: 'NGN',
    policyVersion: '1',
    policyFxMaxAgeMs: 300000,
    tierLimits: {
      0: { daily: '0.00', single: '0.00' },
      1: { daily: '50000.00', single: '20000.00' },
    },
  },
});
injectMock('utils/logger', { info: () => {}, error: () => {} });
injectMock('compliance/smileId.provider', provider);

const { startKycVerification, processSmileIdCallback } = require('../src/compliance/compliance.service');
const user = { id: 'user_1', phoneNumber: '+2348000000000', kycTier: 0 };
const applicant = { country: 'NG', idType: 'NIN', idNumber: '123', firstName: 'Ada', lastName: 'Okafor' };

beforeEach(() => {
  currentProfile = { ...profile };
  submitted = null;
  signatureValid = true;
  duplicate = false;
  provider.submitVerification = async (request) => { submitted = request; };
});

test('starts a real provider job and persists a stable reference', async () => {
  const result = await startKycVerification({ user, applicant });
  assert.equal(result.status, 'pending');
  assert.equal(result.providerReference, 'sendam-profile_1');
  assert.equal(submitted.jobId, 'sendam-profile_1');
});

test('a retry while pending is idempotent and does not resubmit', async () => {
  currentProfile = { ...profile, status: 'pending', providerReference: 'sendam-profile_1' };
  await startKycVerification({ user, applicant });
  assert.equal(submitted, null);
});

test('provider submission failure leaves an operator-recoverable state', async () => {
  provider.submitVerification = async () => { throw new Error('timeout'); };
  await assert.rejects(() => startKycVerification({ user, applicant }), /timeout/);
  assert.equal(currentProfile.status, 'review');
  assert.equal(currentProfile.providerReference, 'sendam-profile_1');
});

test('verified callback atomically approves the profile and user tier', async () => {
  currentProfile = { ...profile, status: 'pending', providerReference: 'sendam-profile_1' };
  const result = await processSmileIdCallback({
    signature: 'valid',
    timestamp: new Date().toISOString(),
    ResultCode: '1020',
    ResultText: 'Exact Match',
    SmileJobID: 'smile-1',
    PartnerParams: { job_id: 'sendam-profile_1', user_id: 'user_1' },
  });
  assert.equal(result.profile.status, 'approved');
  assert.equal(result.profile.tier, 1);
});

test('invalid signature is rejected before database processing', async () => {
  signatureValid = false;
  await assert.rejects(
    () => processSmileIdCallback({ signature: 'bad', timestamp: new Date().toISOString() }),
    { message: 'Invalid or expired Smile ID callback signature' },
  );
});

test('duplicate callback is acknowledged without replaying state changes', async () => {
  duplicate = true;
  currentProfile = { ...profile, status: 'pending', providerReference: 'sendam-profile_1' };
  const result = await processSmileIdCallback({
    signature: 'valid',
    timestamp: new Date().toISOString(),
    ResultCode: '1020',
    PartnerParams: { job_id: 'sendam-profile_1', user_id: 'user_1' },
  });
  assert.equal(result.duplicate, true);
});
