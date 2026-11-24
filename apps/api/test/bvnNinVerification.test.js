'use strict';

const { test, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');

process.env.KYC_PROVIDER = 'dojah';
process.env.DOJAH_APP_ID = 'app_test';
process.env.DOJAH_SECRET_KEY = 'sk_test';
process.env.KYC_ID_HASH_SECRET = 'test-hash-secret';

const state = {};
const mockPrisma = {
  kycProfile: {
    findUnique: async () => state.profile,
    create: async ({ data }) => { state.profile = { id: 'kp-1', metadata: {}, ...data }; return state.profile; },
    update: async ({ data }) => { state.profile = { ...state.profile, ...data }; return state.profile; },
  },
  user: { update: async ({ data }) => { state.userUpdates.push(data); return data; } },
  kycVerification: {
    create: async ({ data }) => { state.verifications.push(data); return { id: `kv-${state.verifications.length}`, ...data }; },
    count: async () => state.attemptCount,
    findFirst: async ({ where }) => (where.status === 'verified' ? state.linkedElsewhere : null),
  },
  auditLog: {
    findFirst: async () => null,
    create: async ({ data }) => { state.audits.push(data); return data; },
  },
};
mockPrisma.$transaction = async (fn) => fn(mockPrisma);
require.cache[require.resolve('../src/common/prisma')] = { exports: mockPrisma };

const kyc = require('../src/compliance/providers/kycProvider');

const USER = { id: 'user-1', phoneNumber: '+2348000000001', kycTier: 0 };
const BVN = '22212345678';
const APPLICANT = { idType: 'BVN', idNumber: BVN, firstName: 'Chinedu', lastName: 'Okafor', dob: '1990-05-14' };

const dojahReturns = (entity) => async (url, opts) => {
  state.httpCalls.push({ url, opts });
  return { data: { entity } };
};
const dojahFails = (status) => async () => {
  throw Object.assign(new Error(`HTTP ${status}`), { response: { status, data: { error: 'x' } } });
};

const auditActions = () => state.audits.map((a) => a.action);

beforeEach(() => {
  state.profile = null;
  state.userUpdates = [];
  state.verifications = [];
  state.audits = [];
  state.httpCalls = [];
  state.attemptCount = 0;
  state.linkedElsewhere = null;
});

describe('helpers', () => {
  test('DOB formats normalize to YYYY-MM-DD; invalid dates are rejected', () => {
    assert.equal(kyc.normalizeDob('1990-05-14'), '1990-05-14');
    assert.equal(kyc.normalizeDob('14-05-1990'), '1990-05-14');
    assert.equal(kyc.normalizeDob('14/05/1990'), '1990-05-14');
    assert.equal(kyc.normalizeDob('14-May-1990'), '1990-05-14');
    assert.equal(kyc.normalizeDob('1990-02-30'), null);
    assert.equal(kyc.normalizeDob('yesterday'), null);
  });

  test('name match is case/accent/order-insensitive and requires DOB', () => {
    const record = { firstName: 'OKAFOR', middleName: 'Ifeanyi', lastName: 'Chinédu', dob: '14-May-1990' };
    assert.equal(kyc.matchIdentity({ firstName: 'chinedu', lastName: 'okafor', dob: '1990-05-14' }, record).matched, true);
    assert.equal(kyc.matchIdentity({ firstName: 'chinedu', lastName: 'okafor', dob: '1991-05-14' }, record).matched, false);
    assert.equal(kyc.matchIdentity({ firstName: 'emeka', lastName: 'okafor', dob: '1990-05-14' }, record).matched, false);
  });

  test('hash is keyed and type-scoped', () => {
    const a = kyc.hashIdNumber('BVN', BVN, 'k1');
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.notEqual(a, kyc.hashIdNumber('BVN', BVN, 'k2'));
    assert.notEqual(a, kyc.hashIdNumber('NIN', BVN, 'k1'));
    assert.throws(() => kyc.hashIdNumber('BVN', BVN, ''), (e) => e.statusCode === 503);
  });
});

describe('verifyBvnNin with Dojah (#982)', () => {
  test('valid BVN with matching details elevates the user to Tier 1 instantly', async () => {
    const result = await kyc.verifyBvnNin(
      { user: USER, ...APPLICANT },
      { httpGet: dojahReturns({ first_name: 'CHINEDU', last_name: 'OKAFOR', date_of_birth: '1990-05-14', reference: 'dj-ref-1' }) },
    );

    assert.deepEqual(result, { status: 'verified', tier: 1 });
    assert.equal(state.profile.tier, 1);
    assert.equal(state.profile.status, 'approved');
    assert.deepEqual(state.userUpdates.at(-1), { kycTier: 1 });
    assert.equal(state.verifications.length, 1);
    assert.equal(state.verifications[0].status, 'verified');
    assert.equal(state.verifications[0].providerReference, 'dj-ref-1');
    assert.ok(auditActions().includes('kyc.verification.approved'));

    // Lookup call shape
    assert.match(state.httpCalls[0].url, /\/api\/v1\/kyc\/bvn\/full$/);
    assert.deepEqual(state.httpCalls[0].opts.params, { bvn: BVN });
    assert.equal(state.httpCalls[0].opts.headers.AppId, 'app_test');
  });

  test('the raw BVN is never stored or audit-logged', async () => {
    await kyc.verifyBvnNin(
      { user: USER, ...APPLICANT },
      { httpGet: dojahReturns({ first_name: 'Chinedu', last_name: 'Okafor', date_of_birth: '1990-05-14' }) },
    );
    const persisted = JSON.stringify({ v: state.verifications, a: state.audits, p: state.profile });
    assert.equal(persisted.includes(BVN), false);
    assert.equal(state.verifications[0].idHash, kyc.hashIdNumber('BVN', BVN, 'test-hash-secret'));
    assert.equal(state.verifications[0].idLast4, '5678');
  });

  test('mismatched details are rejected with an audit entry and no tier change', async () => {
    const result = await kyc.verifyBvnNin(
      { user: USER, ...APPLICANT },
      { httpGet: dojahReturns({ first_name: 'Chinedu', last_name: 'Okafor', date_of_birth: '1985-01-01' }) },
    );
    assert.deepEqual(result, { status: 'rejected', tier: 0, reason: 'details_mismatch' });
    assert.equal(state.profile.tier, 0);
    assert.equal(state.userUpdates.length, 0);
    assert.equal(state.verifications[0].status, 'rejected');
    assert.deepEqual(state.verifications[0].metadata.match, { firstName: true, lastName: true, dob: false });
    assert.ok(auditActions().includes('kyc.verification.rejected'));
  });

  test('an unknown BVN is rejected with an audit entry', async () => {
    const result = await kyc.verifyBvnNin({ user: USER, ...APPLICANT }, { httpGet: dojahFails(404) });
    assert.equal(result.reason, 'id_not_found');
    assert.ok(auditActions().includes('kyc.verification.rejected'));
  });

  test('a provider outage is a retryable error, not a rejection', async () => {
    await assert.rejects(
      kyc.verifyBvnNin({ user: USER, ...APPLICANT }, { httpGet: dojahFails(500) }),
      (e) => e.statusCode === 502 && e.code === 'KYC_PROVIDER_UNAVAILABLE',
    );
    assert.equal(state.verifications.length, 0);
    assert.equal(auditActions().includes('kyc.verification.rejected'), false);
  });

  test('a BVN already verified on another account is rejected without a lookup', async () => {
    state.linkedElsewhere = { id: 'kv-other' };
    const result = await kyc.verifyBvnNin({ user: USER, ...APPLICANT }, { httpGet: dojahReturns({}) });
    assert.equal(result.reason, 'id_linked_to_another_account');
    assert.equal(state.httpCalls.length, 0);
  });

  test('attempts are capped per day', async () => {
    state.attemptCount = kyc.MAX_ATTEMPTS_PER_DAY;
    await assert.rejects(
      kyc.verifyBvnNin({ user: USER, ...APPLICANT }, { httpGet: dojahReturns({}) }),
      (e) => e.statusCode === 429,
    );
    assert.equal(state.httpCalls.length, 0);
  });

  test('an already-verified user is not looked up again', async () => {
    state.profile = { id: 'kp-1', userId: USER.id, tier: 1, status: 'approved', metadata: {} };
    const result = await kyc.verifyBvnNin({ user: USER, ...APPLICANT }, { httpGet: dojahReturns({}) });
    assert.deepEqual(result, { status: 'already_verified', tier: 1 });
    assert.equal(state.httpCalls.length, 0);
  });

  test('NIN uses the NIN lookup', async () => {
    await kyc.verifyBvnNin(
      { user: USER, ...APPLICANT, idType: 'nin' },
      { httpGet: dojahReturns({ firstname: 'Chinedu', surname: 'Okafor', birthdate: '1990-05-14' }) },
    );
    assert.match(state.httpCalls[0].url, /\/api\/v1\/kyc\/nin$/);
    assert.deepEqual(state.httpCalls[0].opts.params, { nin: BVN });
    assert.equal(state.verifications[0].status, 'verified');
  });

  test('invalid input is rejected before any lookup', async () => {
    for (const bad of [{ idType: 'PASSPORT' }, { idNumber: '123' }, { firstName: '' }, { dob: '1990-13-01' }]) {
      await assert.rejects(
        kyc.verifyBvnNin({ user: USER, ...APPLICANT, ...bad }, { httpGet: dojahReturns({}) }),
        (e) => e.statusCode === 400,
      );
    }
    assert.equal(state.httpCalls.length, 0);
  });
});
