'use strict';

// Onboarding status service unit tests — #440
//
// Covers src/compliance/onboarding.service.js: fresh-start, resume
// (in-progress), already-completed and blocked onboarding states. Prisma is
// replaced with an in-memory fake before the SUT is loaded, so nothing
// touches the database.

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const injectMock = (relFromSrc, factory) => {
  const abs = path.resolve(__dirname, '../src', `${relFromSrc}.js`);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: factory() };
};

// The fake returns whatever `currentUser` is set to and records every query.
let currentUser = null;
const findUniqueCalls = [];

injectMock('common/prisma', () => ({
  user: {
    findUnique: async (args) => {
      findUniqueCalls.push(args);
      return currentUser;
    },
  },
}));

const {
  CHECKPOINT_IDS,
  STAGES,
  getOnboardingStatus,
} = require('../src/compliance/onboarding.service');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_ID = 'user_onboarding_1';

const readyWallet = (overrides = {}) => ({
  publicKey: 'GDONBOARDINGTESTWALLETPUBLICKEY000000000000000000000000',
  funded: true,
  fundingState: 'succeeded',
  trustlineState: 'succeeded',
  network: 'testnet',
  ...overrides,
});

const makeUser = (overrides = {}) => ({
  id: USER_ID,
  pinHash: null,
  kycTier: 0,
  deactivatedAt: null,
  deactivationReason: null,
  kycProfile: null,
  wallets: [],
  ...overrides,
});

const checkpoint = (status, id) => status.checkpoints.find((c) => c.id === id);
const completedIds = (status) => status.checkpoints.filter((c) => c.complete).map((c) => c.id);

beforeEach(() => {
  currentUser = null;
  findUniqueCalls.length = 0;
});

// ---------------------------------------------------------------------------
// Exports and query shape
// ---------------------------------------------------------------------------

describe('module exports', () => {
  test('exposes frozen checkpoint ids in onboarding order', () => {
    assert.ok(Object.isFrozen(CHECKPOINT_IDS));
    assert.deepEqual(Object.values(CHECKPOINT_IDS), [
      'account_created',
      'wallet_ready',
      'pin_set',
      'kyc_started',
      'kyc_approved',
      'account_active',
    ]);
  });

  test('exposes the ordered stage list', () => {
    assert.deepEqual(STAGES, ['not_started', 'in_progress', 'blocked', 'complete']);
  });
});

describe('getOnboardingStatus — lookup', () => {
  test('queries the user with KYC profile and the oldest Stellar wallet', async () => {
    currentUser = makeUser();

    await getOnboardingStatus(USER_ID);

    assert.equal(findUniqueCalls.length, 1);
    assert.deepEqual(findUniqueCalls[0], {
      where: { id: USER_ID },
      include: {
        kycProfile: true,
        wallets: {
          where: { chain: 'stellar' },
          orderBy: { createdAt: 'asc' },
          take: 1,
        },
      },
    });
  });

  test('throws a 404 error when the user does not exist', async () => {
    currentUser = null;

    await assert.rejects(getOnboardingStatus('missing_user'), (err) => {
      assert.equal(err.message, 'User not found');
      assert.equal(err.statusCode, 404);
      return true;
    });
  });
});

// ---------------------------------------------------------------------------
// Fresh start
// ---------------------------------------------------------------------------

describe('getOnboardingStatus — fresh start', () => {
  test('brand-new user with no wallet, PIN or KYC is at the first step', async () => {
    currentUser = makeUser();

    const status = await getOnboardingStatus(USER_ID);

    assert.equal(status.userId, USER_ID);
    // Account creation is implicitly complete, so a registered user is never
    // "not_started" — they are in progress at the wallet step.
    assert.equal(status.stage, 'in_progress');
    assert.deepEqual(completedIds(status), [CHECKPOINT_IDS.ACCOUNT_CREATED, CHECKPOINT_IDS.ACCOUNT_ACTIVE]);
    assert.equal(status.percentComplete, 33);
    assert.deepEqual(status.nextStep, {
      action: 'wait',
      message: 'Your wallet is being set up. This usually takes a few seconds.',
    });
    assert.deepEqual(status.blockers, []);
    assert.equal(status.wallet, null);
    assert.deepEqual(status.kyc, {
      status: 'not_started',
      tier: 0,
      sanctionsStatus: 'not_screened',
      providerReference: null,
    });
    assert.equal(status.accountActive, true);
    assert.equal(status.deactivatedAt, null);
    assert.equal(status.deactivationReason, null);
    assert.ok(!Number.isNaN(Date.parse(status.computedAt)));
  });

  test('returns every checkpoint in order with labels and descriptions', async () => {
    currentUser = makeUser();

    const status = await getOnboardingStatus(USER_ID);

    assert.deepEqual(status.checkpoints.map((c) => c.id), Object.values(CHECKPOINT_IDS));
    for (const c of status.checkpoints) {
      assert.equal(typeof c.label, 'string');
      assert.equal(typeof c.description, 'string');
    }
    // With no KYC profile at all, kyc_started is falsy (the service returns
    // the null profile itself rather than a strict boolean).
    assert.ok(!checkpoint(status, CHECKPOINT_IDS.KYC_STARTED).complete);
  });

  test('a not_started KYC profile does not count as KYC started', async () => {
    currentUser = makeUser({
      wallets: [readyWallet()],
      pinHash: 'hashed-pin',
      kycProfile: { status: 'not_started', sanctionsStatus: 'not_screened' },
    });

    const status = await getOnboardingStatus(USER_ID);

    assert.equal(checkpoint(status, CHECKPOINT_IDS.KYC_STARTED).complete, false);
    assert.equal(status.nextStep.action, 'start_kyc');
  });
});

// ---------------------------------------------------------------------------
// Resume in progress
// ---------------------------------------------------------------------------

describe('getOnboardingStatus — resume in progress', () => {
  test('wallet still provisioning keeps the user waiting on the wallet step', async () => {
    currentUser = makeUser({
      wallets: [readyWallet({ funded: false, fundingState: 'pending', trustlineState: 'pending' })],
    });

    const status = await getOnboardingStatus(USER_ID);

    assert.equal(status.stage, 'in_progress');
    assert.equal(checkpoint(status, CHECKPOINT_IDS.WALLET_READY).complete, false);
    assert.equal(checkpoint(status, CHECKPOINT_IDS.WALLET_READY).blocker, null);
    assert.equal(status.nextStep.action, 'wait');
    assert.deepEqual(status.wallet, {
      publicKey: currentUser.wallets[0].publicKey,
      funded: false,
      fundingState: 'pending',
      trustlineState: 'pending',
      network: 'testnet',
    });
  });

  test('wallet funded but trustline pending is not yet ready', async () => {
    currentUser = makeUser({ wallets: [readyWallet({ trustlineState: 'pending' })] });

    const status = await getOnboardingStatus(USER_ID);

    assert.equal(checkpoint(status, CHECKPOINT_IDS.WALLET_READY).complete, false);
    assert.equal(status.nextStep.action, 'wait');
  });

  test('failed wallet funding surfaces a checkpoint blocker without blocking the account', async () => {
    currentUser = makeUser({ wallets: [readyWallet({ funded: false, fundingState: 'failed' })] });

    const status = await getOnboardingStatus(USER_ID);

    assert.equal(
      checkpoint(status, CHECKPOINT_IDS.WALLET_READY).blocker,
      'Wallet funding failed. Please retry or contact support.',
    );
    assert.equal(status.stage, 'in_progress');
    assert.deepEqual(status.blockers, []);
  });

  test('wallet ready resumes at the PIN step', async () => {
    currentUser = makeUser({ wallets: [readyWallet()] });

    const status = await getOnboardingStatus(USER_ID);

    assert.equal(status.stage, 'in_progress');
    assert.equal(status.percentComplete, 50);
    assert.deepEqual(status.nextStep, {
      action: 'set_pin',
      message: 'Set a 4-digit PIN to secure your payments.',
    });
  });

  test('wallet and PIN done resumes at the start-KYC step', async () => {
    currentUser = makeUser({ wallets: [readyWallet()], pinHash: 'hashed-pin' });

    const status = await getOnboardingStatus(USER_ID);

    assert.equal(status.stage, 'in_progress');
    assert.equal(status.percentComplete, 67);
    assert.equal(status.nextStep.action, 'start_kyc');
  });

  test('KYC submitted but pending review resumes at the await-review step', async () => {
    currentUser = makeUser({
      wallets: [readyWallet()],
      pinHash: 'hashed-pin',
      kycProfile: {
        status: 'pending',
        sanctionsStatus: 'clear',
        providerReference: 'smile_job_123',
      },
    });

    const status = await getOnboardingStatus(USER_ID);

    assert.equal(status.stage, 'in_progress');
    assert.equal(status.percentComplete, 83);
    assert.equal(checkpoint(status, CHECKPOINT_IDS.KYC_STARTED).complete, true);
    assert.equal(checkpoint(status, CHECKPOINT_IDS.KYC_APPROVED).complete, false);
    assert.equal(status.nextStep.action, 'await_review');
    assert.deepEqual(status.kyc, {
      status: 'pending',
      tier: 0,
      sanctionsStatus: 'clear',
      providerReference: 'smile_job_123',
    });
  });

  test('an earlier incomplete step is reported before later completed ones', async () => {
    // PIN and KYC done, but the wallet is still provisioning.
    currentUser = makeUser({
      wallets: [readyWallet({ funded: false, fundingState: 'pending' })],
      pinHash: 'hashed-pin',
      kycProfile: { status: 'approved', sanctionsStatus: 'clear' },
    });

    const status = await getOnboardingStatus(USER_ID);

    assert.equal(status.stage, 'in_progress');
    assert.equal(status.nextStep.action, 'wait');
  });
});

// ---------------------------------------------------------------------------
// Already completed
// ---------------------------------------------------------------------------

describe('getOnboardingStatus — already completed', () => {
  test('fully onboarded user is complete with no next action', async () => {
    currentUser = makeUser({
      wallets: [readyWallet()],
      pinHash: 'hashed-pin',
      kycTier: 1,
      kycProfile: {
        status: 'approved',
        sanctionsStatus: 'clear',
        providerReference: 'smile_job_456',
      },
    });

    const status = await getOnboardingStatus(USER_ID);

    assert.equal(status.stage, 'complete');
    assert.equal(status.percentComplete, 100);
    assert.ok(status.checkpoints.every((c) => c.complete));
    assert.deepEqual(status.nextStep, { action: 'none', message: 'Your account is fully set up.' });
    assert.deepEqual(status.blockers, []);
    assert.equal(status.accountActive, true);
    assert.deepEqual(status.kyc, {
      status: 'approved',
      tier: 1,
      sanctionsStatus: 'clear',
      providerReference: 'smile_job_456',
    });
  });

  test('an existing KYC tier counts as approved even if the profile is still in review', async () => {
    currentUser = makeUser({
      wallets: [readyWallet()],
      pinHash: 'hashed-pin',
      kycTier: 2,
      kycProfile: { status: 'review', sanctionsStatus: 'clear' },
    });

    const status = await getOnboardingStatus(USER_ID);

    assert.equal(checkpoint(status, CHECKPOINT_IDS.KYC_APPROVED).complete, true);
    assert.equal(status.stage, 'complete');
  });

  test('is idempotent: repeated calls for a completed user return the same result', async () => {
    currentUser = makeUser({
      wallets: [readyWallet()],
      pinHash: 'hashed-pin',
      kycTier: 1,
      kycProfile: { status: 'approved', sanctionsStatus: 'clear' },
    });

    const first = await getOnboardingStatus(USER_ID);
    const second = await getOnboardingStatus(USER_ID);

    delete first.computedAt;
    delete second.computedAt;
    assert.deepEqual(second, first);
    assert.equal(findUniqueCalls.length, 2);
  });
});

// ---------------------------------------------------------------------------
// Blocked
// ---------------------------------------------------------------------------

describe('getOnboardingStatus — blocked', () => {
  const completedUser = (overrides = {}) => makeUser({
    wallets: [readyWallet()],
    pinHash: 'hashed-pin',
    kycTier: 1,
    kycProfile: { status: 'approved', sanctionsStatus: 'clear' },
    ...overrides,
  });

  test('a deactivated account is blocked even when every other step is done', async () => {
    const deactivatedAt = new Date('2026-09-01T00:00:00Z');
    currentUser = completedUser({ deactivatedAt, deactivationReason: 'user_request' });

    const status = await getOnboardingStatus(USER_ID);

    assert.equal(status.stage, 'blocked');
    assert.equal(status.accountActive, false);
    assert.equal(status.deactivatedAt, deactivatedAt);
    assert.equal(status.deactivationReason, 'user_request');
    assert.deepEqual(status.blockers, [
      'Your account has been deactivated. Contact support to restore access.',
    ]);
    assert.deepEqual(status.nextStep, { action: 'contact_support', message: status.blockers[0] });
    const active = checkpoint(status, CHECKPOINT_IDS.ACCOUNT_ACTIVE);
    assert.equal(active.complete, false);
    assert.equal(active.blocker, status.blockers[0]);
  });

  test('a sanctions hold blocks onboarding', async () => {
    currentUser = completedUser({ kycProfile: { status: 'approved', sanctionsStatus: 'blocked' } });

    const status = await getOnboardingStatus(USER_ID);

    assert.equal(status.stage, 'blocked');
    assert.deepEqual(status.blockers, [
      'Your account is under a compliance hold. Contact support for assistance.',
    ]);
    assert.equal(status.kyc.sanctionsStatus, 'blocked');
  });

  test('a rejected KYC profile blocks onboarding', async () => {
    currentUser = makeUser({
      wallets: [readyWallet()],
      pinHash: 'hashed-pin',
      kycProfile: { status: 'rejected', sanctionsStatus: 'clear' },
    });

    const status = await getOnboardingStatus(USER_ID);

    assert.equal(status.stage, 'blocked');
    assert.deepEqual(status.blockers, [
      'Your identity verification was not approved. Contact support to appeal or re-verify.',
    ]);
    assert.equal(status.nextStep.action, 'contact_support');
  });

  test('multiple blockers are reported in order and the first drives the next step', async () => {
    currentUser = makeUser({
      deactivatedAt: new Date('2026-09-01T00:00:00Z'),
      kycProfile: { status: 'rejected', sanctionsStatus: 'blocked' },
    });

    const status = await getOnboardingStatus(USER_ID);

    assert.equal(status.stage, 'blocked');
    assert.equal(status.blockers.length, 3);
    assert.match(status.blockers[0], /deactivated/);
    assert.match(status.blockers[1], /compliance hold/);
    assert.match(status.blockers[2], /not approved/);
    assert.equal(status.nextStep.message, status.blockers[0]);
  });
});
