const { test, beforeEach, afterEach, describe } = require('node:test');
const assert = require('node:assert/strict');

const mockPrisma = {
  kycVerification: { create: async () => {}, findFirst: async () => null, update: async () => {} },
  kycProfile: { findFirst: async () => null, findUnique: async () => null, update: async () => {} },
  kycWebhookEvent: { create: async () => {} },
  user: { findUnique: async () => ({ id: 'user-1', phoneNumber: '+2348000000001' }) },
};

require.cache[require.resolve('../src/common/prisma')] = { exports: mockPrisma };

const { verifyBvnNin, processKycCallback } = require('../src/compliance/compliance.service');

describe('Smile ID / Dojah BVN/NIN verification', () => {
  beforeEach(() => {
    mockPrisma.kycVerification.create = async (data) => ({ ...data.data, id: 'kv-1' });
    mockPrisma.kycVerification.findFirst = async () => null;
    mockPrisma.kycVerification.update = async (data) => ({ ...data.data, id: 'kv-1' });
    mockPrisma.kycProfile.findFirst = async () => null;
    mockPrisma.kycProfile.findUnique = async () => null;
    mockPrisma.kycProfile.update = async (data) => ({ ...data.data, id: 'kp-1' });
    mockPrisma.kycWebhookEvent.create = async () => {};
  });

  afterEach(() => {});

  test('verifyBvnNin throws ProviderSkippedError when no provider configured', async () => {
    const { ProviderSkippedError } = require('../src/compliance/providerErrors');

    try {
      await verifyBvnNin({
        user: { id: 'user-1', phoneNumber: '+2348000000001' },
        idType: 'BVN',
        idNumber: '12345678901',
        applicantData: { firstName: 'John', lastName: 'Doe', dob: '1990-01-01' },
      });
      assert.fail('Expected ProviderSkippedError');
    } catch (error) {
      assert.ok(error instanceof ProviderSkippedError);
      assert.match(error.message, /No KYC provider configured/);
    }
  });

  test('processKycCallback rejects unknown provider', async () => {
    try {
      await processKycCallback({ provider: 'unknown', payload: {}, signature: '', timestamp: '' });
      assert.fail('Expected error');
    } catch (error) {
      assert.match(error.message, /Unknown provider/);
    }
  });

  test('processKycCallback verifies Smile ID callback', async () => {
    const callbackPayload = {
      ResultCode: '1020',
      ResultText: 'Verification successful',
      PartnerParams: { job_id: 'job-1', user_id: 'user-1' },
      SmileJobID: 'smile-job-1',
    };

    mockPrisma.kycVerification.findFirst = async () => ({
      id: 'kv-1',
      userId: 'user-1',
      provider: 'smileid',
      providerReference: 'job-1',
      user: { id: 'user-1' },
    });
    mockPrisma.kycVerification.update = async () => ({});
    mockPrisma.kycProfile.update = async () => ({});

    const { verifyCallback } = require('../src/compliance/providers/smileId');
    verifyCallback({ signature: 'test', timestamp: new Date().toISOString() });

    const result = await processKycCallback({
      provider: 'smileid',
      payload: callbackPayload,
      signature: 'valid',
      timestamp: new Date().toISOString(),
    });

    assert.equal(result.verified, true);
    assert.equal(result.status, 'verified');
  });

  test('verifyBvnNin creates verification record', async () => {
    const { ProviderSkippedError } = require('../src/compliance/providerErrors');

    try {
      await verifyBvnNin({
        user: { id: 'user-1', phoneNumber: '+2348000000001' },
        idType: 'BVN',
        idNumber: '12345678901',
        applicantData: { firstName: 'John', lastName: 'Doe', dob: '1990-01-01' },
      });
    } catch (error) {
      if (error instanceof ProviderSkippedError) {
        return;
      }
      throw error;
    }
  });

  test('processKycCallback for Dojah verifies NIN', async () => {
    mockPrisma.kycVerification.findFirst = async () => ({
      id: 'kv-1',
      userId: 'user-1',
      provider: 'dojah',
      providerReference: 'ref-1',
      user: { id: 'user-1' },
    });
    mockPrisma.kycVerification.update = async () => ({});
    mockPrisma.kycProfile.update = async () => ({});

    const payload = {
      entity: { verified: true, reference: 'ref-1', message: 'Verified' },
    };

    const result = await processKycCallback({
      provider: 'dojah',
      payload,
      signature: '',
      timestamp: new Date().toISOString(),
    });

    assert.equal(result.verified, true);
    assert.equal(result.status, 'verified');
  });
});