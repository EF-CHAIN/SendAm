'use strict';

const { test, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/sendam_test';
process.env.KYC_PROVIDER = 'dojah';
process.env.DOJAH_APP_ID = 'app_test';
process.env.DOJAH_SECRET_KEY = 'sk_test';
process.env.KYC_ID_HASH_SECRET = 'test-hash-secret';

const state = {};
const mockPrisma = {
  kycProfile: {
    findUnique: async () => state.profile,
    create: async ({ data }) => {
      state.profile = { id: 'kp-1', metadata: {}, ...data };
      return state.profile;
    },
    update: async ({ data }) => {
      state.profile = { ...state.profile, ...data };
      return state.profile;
    },
  },
  user: {
    update: async ({ data }) => {
      state.userUpdates.push(data);
      return data;
    },
  },
  kycVerification: {
    create: async ({ data }) => {
      state.verifications.push(data);
      return { id: `kv-${state.verifications.length}`, ...data };
    },
    count: async () => state.attemptCount,
    findFirst: async ({ where }) => (where.status === 'verified' ? state.linkedElsewhere : null),
  },
  auditLog: {
    findFirst: async () => null,
    create: async ({ data }) => {
      state.audits.push(data);
      return data;
    },
  },
  auditChainHead: {
    findUnique: async () => null,
    update: async () => null,
    create: async () => null,
  },
  workflowEvent: {
    findFirst: async () => null,
    create: async () => null,
  },
};
mockPrisma.$transaction = async (fn) => fn(mockPrisma);
require.cache[require.resolve('../src/common/prisma')] = { exports: mockPrisma };

const regionalKyc = require('../src/compliance/providers/ghanaKenyaKyc');

const GH_USER = { id: 'user-gh-1', phoneNumber: '+233201234567', kycTier: 0 };
const KE_USER = { id: 'user-ke-1', phoneNumber: '+254712345678', kycTier: 0 };

const GH_CARD = 'GHA-123456789-1';
const GH_APPLICANT = {
  country: 'GH',
  idType: 'GHANA_CARD',
  idNumber: GH_CARD,
  firstName: 'Kwame',
  lastName: 'Mensah',
  dob: '1990-05-15',
};

const KE_ID = '12345678';
const KE_APPLICANT = {
  country: 'KE',
  idType: 'KENYA_ID',
  idNumber: KE_ID,
  firstName: 'Juma',
  lastName: 'Mwangi',
  dob: '1988-12-05',
};

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
  process.env.KYC_PROVIDER = 'dojah';
});

describe('Ghana & Kenya KYC Helpers & Validation (#983)', () => {
  test('normalizeCountry supports GH and KE variations', () => {
    assert.equal(regionalKyc.normalizeCountry('GH'), 'GH');
    assert.equal(regionalKyc.normalizeCountry('gha'), 'GH');
    assert.equal(regionalKyc.normalizeCountry('Ghana'), 'GH');
    assert.equal(regionalKyc.normalizeCountry('KE'), 'KE');
    assert.equal(regionalKyc.normalizeCountry('ken'), 'KE');
    assert.equal(regionalKyc.normalizeCountry('Kenya'), 'KE');
    assert.throws(() => regionalKyc.normalizeCountry('NG'), (e) => e.statusCode === 400);
  });

  test('normalizeIdType supports Ghana Card and Kenyan National ID', () => {
    assert.equal(regionalKyc.normalizeIdType('GH', null), 'GHANA_CARD');
    assert.equal(regionalKyc.normalizeIdType('GH', 'ghana_card'), 'GHANA_CARD');
    assert.equal(regionalKyc.normalizeIdType('GH', 'card'), 'GHANA_CARD');
    assert.equal(regionalKyc.normalizeIdType('KE', null), 'KENYA_ID');
    assert.equal(regionalKyc.normalizeIdType('KE', 'national_id'), 'KENYA_ID');
    assert.equal(regionalKyc.normalizeIdType('KE', 'id'), 'KENYA_ID');
    assert.throws(() => regionalKyc.normalizeIdType('GH', 'BVN'), (e) => e.statusCode === 400);
  });

  test('formatAndValidateIdNumber formats Ghana Card and validates Kenyan ID', () => {
    assert.equal(regionalKyc.formatAndValidateIdNumber('GHANA_CARD', 'GHA-123456789-1'), 'GHA-123456789-1');
    assert.equal(regionalKyc.formatAndValidateIdNumber('GHANA_CARD', 'gha1234567891'), 'GHA-123456789-1');
    assert.equal(regionalKyc.formatAndValidateIdNumber('GHANA_CARD', 'GHA-1234567891'), 'GHA-123456789-1');
    assert.throws(() => regionalKyc.formatAndValidateIdNumber('GHANA_CARD', '123456789'), (e) => e.statusCode === 400);

    assert.equal(regionalKyc.formatAndValidateIdNumber('KENYA_ID', '1234567'), '1234567');
    assert.equal(regionalKyc.formatAndValidateIdNumber('KENYA_ID', '12345678'), '12345678');
    assert.equal(regionalKyc.formatAndValidateIdNumber('KENYA_ID', '123456789'), '123456789');
    assert.throws(() => regionalKyc.formatAndValidateIdNumber('KENYA_ID', '12345'), (e) => e.statusCode === 400);
    assert.throws(() => regionalKyc.formatAndValidateIdNumber('KENYA_ID', 'ABC12345'), (e) => e.statusCode === 400);
  });

  test('hashIdNumber produces consistent keyed HMAC', () => {
    const h1 = regionalKyc.hashIdNumber('GHANA_CARD', GH_CARD, 'sec1');
    const h2 = regionalKyc.hashIdNumber('GHANA_CARD', GH_CARD, 'sec1');
    const h3 = regionalKyc.hashIdNumber('GHANA_CARD', GH_CARD, 'sec2');
    assert.equal(h1, h2);
    assert.notEqual(h1, h3);
    assert.throws(() => regionalKyc.hashIdNumber('GHANA_CARD', GH_CARD, ''), (e) => e.statusCode === 503);
  });

  test('matchIdentity matches order, case, and accents with DOB match', () => {
    const record = { firstName: 'MENSAH', middleName: 'Kofi', lastName: 'Kwame', dob: '15-May-1990' };
    assert.equal(regionalKyc.matchIdentity({ firstName: 'kwame', lastName: 'mensah', dob: '1990-05-15' }, record).matched, true);
    assert.equal(regionalKyc.matchIdentity({ firstName: 'kwame', lastName: 'mensah', dob: '1991-05-15' }, record).matched, false);
    assert.equal(regionalKyc.matchIdentity({ firstName: 'john', lastName: 'mensah', dob: '1990-05-15' }, record).matched, false);
  });
});

describe('verifyRegionalId with Dojah (#983)', () => {
  test('valid Ghana Card elevates user to Tier 1 and syncs risk state', async () => {
    const result = await regionalKyc.verifyRegionalId(
      { user: GH_USER, ...GH_APPLICANT },
      { httpGet: dojahReturns({ first_name: 'KWAME', last_name: 'MENSAH', date_of_birth: '1990-05-15', reference: 'dj-gh-1' }) },
    );

    assert.deepEqual(result, { status: 'verified', tier: 1 });
    assert.equal(state.profile.tier, 1);
    assert.equal(state.profile.status, 'approved');
    assert.deepEqual(state.userUpdates.at(-1), { kycTier: 1 });
    assert.equal(state.verifications.length, 1);
    assert.equal(state.verifications[0].status, 'verified');
    assert.equal(state.verifications[0].idType, 'GHANA_CARD');
    assert.equal(state.verifications[0].providerReference, 'dj-gh-1');
    assert.ok(auditActions().includes('kyc.verification.approved'));

    assert.match(state.httpCalls[0].url, /\/api\/v1\/gh\/kyc$/);
    assert.equal(state.httpCalls[0].opts.params.id, GH_CARD);
    assert.equal(state.httpCalls[0].opts.params.id_type, 'ghana_card');
  });

  test('valid Kenya ID elevates user to Tier 1 and syncs risk state', async () => {
    const result = await regionalKyc.verifyRegionalId(
      { user: KE_USER, ...KE_APPLICANT },
      { httpGet: dojahReturns({ first_name: 'JUMA', last_name: 'MWANGI', date_of_birth: '1988-12-05', reference: 'dj-ke-1' }) },
    );

    assert.deepEqual(result, { status: 'verified', tier: 1 });
    assert.equal(state.profile.tier, 1);
    assert.equal(state.profile.status, 'approved');
    assert.deepEqual(state.userUpdates.at(-1), { kycTier: 1 });
    assert.equal(state.verifications.length, 1);
    assert.equal(state.verifications[0].status, 'verified');
    assert.equal(state.verifications[0].idType, 'KENYA_ID');
    assert.equal(state.verifications[0].providerReference, 'dj-ke-1');
    assert.ok(auditActions().includes('kyc.verification.approved'));

    assert.match(state.httpCalls[0].url, /\/api\/v1\/ke\/kyc$/);
    assert.equal(state.httpCalls[0].opts.params.id, KE_ID);
    assert.equal(state.httpCalls[0].opts.params.id_type, 'national_id');
  });

  test('the raw ID is never stored or audit-logged', async () => {
    await regionalKyc.verifyRegionalId(
      { user: GH_USER, ...GH_APPLICANT },
      { httpGet: dojahReturns({ first_name: 'Kwame', last_name: 'Mensah', date_of_birth: '1990-05-15' }) },
    );

    const persisted = JSON.stringify({ v: state.verifications, a: state.audits, p: state.profile });
    assert.equal(persisted.includes(GH_CARD), false);
    assert.equal(state.verifications[0].idHash, regionalKyc.hashIdNumber('GHANA_CARD', GH_CARD, 'test-hash-secret'));
    assert.equal(state.verifications[0].idLast4, '89-1');
  });

  test('mismatched details are rejected without tier elevation', async () => {
    const result = await regionalKyc.verifyRegionalId(
      { user: GH_USER, ...GH_APPLICANT },
      { httpGet: dojahReturns({ first_name: 'Kwame', last_name: 'Mensah', date_of_birth: '1970-01-01' }) },
    );

    assert.deepEqual(result, { status: 'rejected', tier: 0, reason: 'details_mismatch' });
    assert.equal(state.profile.tier, 0);
    assert.equal(state.userUpdates.length, 0);
    assert.equal(state.verifications[0].status, 'rejected');
    assert.ok(auditActions().includes('kyc.verification.rejected'));
  });

  test('unknown ID is rejected with id_not_found', async () => {
    const result = await regionalKyc.verifyRegionalId(
      { user: GH_USER, ...GH_APPLICANT },
      { httpGet: dojahFails(404) },
    );

    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, 'id_not_found');
    assert.ok(auditActions().includes('kyc.verification.rejected'));
  });

  test('provider outage returns 502/503 retryable error', async () => {
    await assert.rejects(
      regionalKyc.verifyRegionalId({ user: GH_USER, ...GH_APPLICANT }, { httpGet: dojahFails(500) }),
      (e) => e.statusCode === 502 && e.code === 'KYC_PROVIDER_UNAVAILABLE',
    );
    assert.equal(state.verifications.length, 0);
    assert.equal(auditActions().includes('kyc.verification.rejected'), false);
  });

  test('duplicate ID on another account is rejected without lookup', async () => {
    state.linkedElsewhere = { id: 'kv-other' };
    const result = await regionalKyc.verifyRegionalId(
      { user: GH_USER, ...GH_APPLICANT },
      { httpGet: dojahReturns({}) },
    );

    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, 'id_linked_to_another_account');
    assert.equal(state.httpCalls.length, 0);
  });

  test('rate limit caps attempts at 5 per day', async () => {
    state.attemptCount = 5;
    await assert.rejects(
      regionalKyc.verifyRegionalId({ user: GH_USER, ...GH_APPLICANT }, { httpGet: dojahReturns({}) }),
      (e) => e.statusCode === 429 && e.code === 'KYC_TOO_MANY_ATTEMPTS',
    );
    assert.equal(state.httpCalls.length, 0);
  });

  test('already verified user is not looked up again', async () => {
    state.profile = { id: 'kp-1', userId: GH_USER.id, tier: 1, status: 'approved', metadata: {} };
    const result = await regionalKyc.verifyRegionalId(
      { user: GH_USER, ...GH_APPLICANT },
      { httpGet: dojahReturns({}) },
    );

    assert.deepEqual(result, { status: 'already_verified', tier: 1 });
    assert.equal(state.httpCalls.length, 0);
  });
});

describe('WhatsApp Conversational KYC Prompt (#983)', () => {
  test('prompts Ghana user with Ghana Card instructions when asking for KYC', async () => {
    const messages = [];
    const notify = async (phone, text) => { messages.push({ phone, text }); };

    const handled = await regionalKyc.handleRegionalKycPrompt({
      phoneNumber: '+233201234567',
      user: GH_USER,
      text: 'kyc',
      notify,
      db: mockPrisma,
    });

    assert.equal(handled, true);
    assert.equal(messages.length, 1);
    assert.match(messages[0].text, /Ghana Card/i);
    assert.match(messages[0].text, /GHA-123456789-1/);
  });

  test('prompts Kenya user with National ID instructions when asking for KYC', async () => {
    const messages = [];
    const notify = async (phone, text) => { messages.push({ phone, text }); };

    const handled = await regionalKyc.handleRegionalKycPrompt({
      phoneNumber: '+254712345678',
      user: KE_USER,
      text: 'verify',
      notify,
      db: mockPrisma,
    });

    assert.equal(handled, true);
    assert.equal(messages.length, 1);
    assert.match(messages[0].text, /Kenyan National ID/i);
    assert.match(messages[0].text, /12345678/);
  });

  test('executes verification when Ghana user provides KYC message', async () => {
    const messages = [];
    const notify = async (phone, text) => { messages.push({ phone, text }); };

    const handled = await regionalKyc.handleRegionalKycPrompt({
      phoneNumber: '+233201234567',
      user: GH_USER,
      text: 'KYC GHA-123456789-1 Kwame Mensah 1990-05-15',
      notify,
      db: mockPrisma,
      deps: { httpGet: dojahReturns({ first_name: 'KWAME', last_name: 'MENSAH', date_of_birth: '1990-05-15', reference: 'dj-gh-1' }) },
    });

    assert.equal(handled, true);
    assert.equal(messages.length, 1);
    assert.match(messages[0].text, /Identity verified successfully/i);
    assert.match(messages[0].text, /Tier 1/i);
    assert.equal(state.verifications.length, 1);
    assert.equal(state.verifications[0].status, 'verified');
  });

  test('returns false for unrelated text', async () => {
    const handled = await regionalKyc.handleRegionalKycPrompt({
      phoneNumber: '+233201234567',
      user: GH_USER,
      text: 'send 100 to Kwame',
      notify: async () => {},
      db: mockPrisma,
    });
    assert.equal(handled, false);
  });
});

describe('Web REST Controller: verifyRegionalId (#983)', () => {
  const controller = require('../src/compliance/compliance.controller');

  test('successfully processes valid Ghana verification through controller', async () => {
    const req = {
      restUser: GH_USER,
      body: GH_APPLICANT,
    };
    let responseData = null;
    let statusCode = 200;
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(data) {
        responseData = data;
        return this;
      },
    };

    // Override dojah lookup in dojah.lookupIdentity or pass through
    const dojah = require('../src/compliance/providers/dojah');
    const origLookup = dojah.lookupIdentity;
    dojah.lookupIdentity = async () => ({
      firstName: 'Kwame',
      lastName: 'Mensah',
      dob: '1990-05-15',
      reference: 'dj-controller-1',
    });

    try {
      await controller.verifyRegionalId(req, res, (err) => { throw err; });
      assert.equal(statusCode, 200);
      assert.equal(responseData?.success, true);
      assert.equal(responseData?.data?.status, 'verified');
      assert.equal(responseData?.data?.tier, 1);
    } finally {
      dojah.lookupIdentity = origLookup;
    }
  });

  test('returns client error when required fields are missing', async () => {
    const req = {
      restUser: GH_USER,
      body: { country: 'GH' },
    };
    let responseData = null;
    let statusCode = 200;
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(data) {
        responseData = data;
        return this;
      },
    };

    await controller.verifyRegionalId(req, res, (err) => { throw err; });
    assert.equal(statusCode, 400);
    assert.equal(responseData?.success, false);
  });
});
