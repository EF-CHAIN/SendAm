const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { runPhoneCanonicalization } = require('../scripts/canonicalize-phone-numbers');

describe('runPhoneCanonicalization migration tool', () => {
  test('handles clean canonical rows without updates or collisions', async () => {
    const fakeUsers = [
      { id: 'u1', phoneNumber: '+2348000000001', wallets: [{ id: 'w1' }], transactions: [], kycProfile: null },
      { id: 'u2', phoneNumber: '+2348000000002', wallets: [{ id: 'w2' }], transactions: [], kycProfile: null },
    ];

    const fakePrisma = {
      user: {
        findMany: async () => fakeUsers,
      },
    };

    const report = await runPhoneCanonicalization({ prisma: fakePrisma, apply: false });

    assert.equal(report.scannedUsersCount, 2);
    assert.equal(report.alreadyCanonicalCount, 2);
    assert.equal(report.updatedUsersCount, 0);
    assert.equal(report.collisionsCount, 0);
    assert.equal(report.invalidPhoneCount, 0);
  });

  test('detects non-canonical rows and prepares updates in dry-run mode', async () => {
    const fakeUsers = [
      { id: 'u1', phoneNumber: '08000000001', wallets: [{ id: 'w1' }], transactions: [], kycProfile: null },
      { id: 'u2', phoneNumber: '2348000000002', wallets: [{ id: 'w2' }], transactions: [], kycProfile: null },
    ];

    const fakePrisma = {
      user: {
        findMany: async () => fakeUsers,
      },
    };

    const report = await runPhoneCanonicalization({ prisma: fakePrisma, apply: false });

    assert.equal(report.scannedUsersCount, 2);
    assert.equal(report.alreadyCanonicalCount, 0);
    assert.equal(report.collisionsCount, 0);
    assert.equal(report.updates.length, 2);
    assert.deepEqual(report.updates[0], {
      userId: 'u1',
      oldPhoneNumber: '08000000001',
      newPhoneNumber: '+2348000000001',
    });
    assert.deepEqual(report.updates[1], {
      userId: 'u2',
      oldPhoneNumber: '2348000000002',
      newPhoneNumber: '+2348000000002',
    });
  });

  test('applies updates to User and Wallet records when apply is true', async () => {
    const fakeUsers = [
      { id: 'u1', phoneNumber: '08000000001', wallets: [{ id: 'w1' }], transactions: [], kycProfile: null },
    ];

    const updatedUser = [];
    const updatedWallet = [];

    const fakePrisma = {
      user: {
        findMany: async () => fakeUsers,
      },
      $transaction: async (fn) => {
        const tx = {
          user: {
            update: async (args) => { updatedUser.push(args); },
          },
          wallet: {
            updateMany: async (args) => { updatedWallet.push(args); },
          },
        };
        return fn(tx);
      },
    };

    const report = await runPhoneCanonicalization({ prisma: fakePrisma, apply: true });

    assert.equal(report.updatedUsersCount, 1);
    assert.equal(updatedUser.length, 1);
    assert.deepEqual(updatedUser[0], {
      where: { id: 'u1' },
      data: { phoneNumber: '+2348000000001' },
    });
    assert.equal(updatedWallet.length, 1);
    assert.deepEqual(updatedWallet[0], {
      where: { userId: 'u1' },
      data: { phoneNumber: '+2348000000001' },
    });
  });

  test('flags collision and requires manual review without silently merging financial identities', async () => {
    const fakeUsers = [
      {
        id: 'u1',
        phoneNumber: '08000000001',
        wallets: [{ id: 'w1' }],
        transactions: [{ id: 't1' }],
        pinHash: 'hash1',
        kycTier: 1,
      },
      {
        id: 'u2',
        phoneNumber: '+2348000000001',
        wallets: [{ id: 'w2' }],
        transactions: [],
        pinHash: 'hash2',
        kycTier: 2,
      },
    ];

    const fakePrisma = {
      user: {
        findMany: async () => fakeUsers,
      },
    };

    const report = await runPhoneCanonicalization({ prisma: fakePrisma, apply: true });

    assert.equal(report.scannedUsersCount, 2);
    assert.equal(report.collisionsCount, 1);
    assert.equal(report.updatedUsersCount, 0);
    assert.equal(report.collisions[0].canonicalPhone, '+2348000000001');
    assert.equal(report.collisions[0].requiresManualReview, true);
    assert.equal(report.collisions[0].totalUsers, 2);
    assert.equal(report.collisions[0].financialUsersCount, 2);
  });

  test('scans and canonicalizes secondary models (Contact, Transaction, VoiceCommand, SimMessage, Notification, Alias)', async () => {
    const fakePrisma = {
      user: { findMany: async () => [] },
      contact: {
        findMany: async () => [
          { id: 'c1', ownerId: 'u1', phoneNumber: '08012345678' },
        ],
      },
      transaction: {
        findMany: async () => [
          { id: 't1', recipientPhoneNumber: '08022223333' },
        ],
      },
      voiceCommand: {
        findMany: async () => [
          { id: 'vc1', phoneNumber: '08033334444' },
        ],
      },
      simMessage: {
        findMany: async () => [
          { id: 'sm1', phoneNumber: '08044445555' },
        ],
      },
      notification: {
        findMany: async () => [
          { id: 'n1', recipient: '08055556666' },
        ],
      },
      alias: {
        findMany: async () => [
          { id: 'a1', targetType: 'phone', target: '08066667777' },
        ],
      },
    };

    const report = await runPhoneCanonicalization({ prisma: fakePrisma, apply: false });

    assert.equal(report.crossModelUpdatesCount, 6);
    assert.equal(report.secondaryUpdates.contacts[0].newPhoneNumber, '+2348012345678');
    assert.equal(report.secondaryUpdates.transactions[0].newPhoneNumber, '+2348022223333');
    assert.equal(report.secondaryUpdates.voiceCommands[0].newPhoneNumber, '+2348033334444');
    assert.equal(report.secondaryUpdates.simMessages[0].newPhoneNumber, '+2348044445555');
    assert.equal(report.secondaryUpdates.notifications[0].newRecipient, '+2348055556666');
    assert.equal(report.secondaryUpdates.aliases[0].newTarget, '+2348066667777');
  });

  test('detects Contact collisions for same owner and requires manual review', async () => {
    const fakePrisma = {
      user: { findMany: async () => [] },
      contact: {
        findMany: async () => [
          { id: 'c1', ownerId: 'u1', phoneNumber: '08012345678' },
          { id: 'c2', ownerId: 'u1', phoneNumber: '+2348012345678' },
        ],
      },
    };

    const report = await runPhoneCanonicalization({ prisma: fakePrisma, apply: false });

    assert.equal(report.contactCollisions.length, 1);
    assert.equal(report.contactCollisions[0].canonicalPhone, '+2348012345678');
    assert.equal(report.contactCollisions[0].requiresManualReview, true);
    assert.equal(report.secondaryUpdates.contacts.length, 0);
  });
});
