const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  runCustomerIdentityMigration,
  applyRollback,
} = require('../scripts/migrate-customer-identities');

describe('Customer Identity Migration & Rollback Tooling (#334)', () => {
  test('dry-run mode identifies legacy records and captures snapshot without DB writes', async () => {
    const fakeUsers = [
      { id: 'u1', phoneNumber: '08012345678', wallets: [{ id: 'w1', phoneNumber: '08012345678', userId: 'u1' }] },
      { id: 'u2', phoneNumber: '+2348022223333', wallets: [{ id: 'w2', phoneNumber: '+2348022223333', userId: 'u2' }] },
    ];
    const fakeWallets = [
      { id: 'w1', userId: 'u1', phoneNumber: '08012345678' },
      { id: 'w2', userId: 'u2', phoneNumber: '+2348022223333' },
    ];

    const fakePrisma = {
      user: { findMany: async () => fakeUsers },
      wallet: { findMany: async () => fakeWallets },
    };

    const report = await runCustomerIdentityMigration({ prisma: fakePrisma, apply: false });

    assert.equal(report.mode, 'dry-run');
    assert.equal(report.scannedUsersCount, 2);
    assert.equal(report.updatedUsersCount, 0);
    assert.equal(report.updates.length, 1);
    assert.equal(report.updates[0].newPhoneNumber, '+2348012345678');
    assert.equal(report.snapshot.userSnapshots.length, 1);
    assert.equal(report.preMigrationIntegrityOk, true);
    assert.equal(report.postMigrationIntegrityOk, true);
  });

  test('apply mode updates records transactionally and verifies wallet ownership', async () => {
    const fakeUsers = [
      { id: 'u1', phoneNumber: '08012345678', wallets: [{ id: 'w1', phoneNumber: '08012345678', userId: 'u1' }] },
    ];
    const fakeWallets = [
      { id: 'w1', userId: 'u1', phoneNumber: '08012345678' },
    ];

    const updatedUsers = [];
    const updatedWallets = [];

    const fakePrisma = {
      user: { findMany: async () => fakeUsers },
      wallet: { findMany: async () => fakeWallets },
      $transaction: async (fn) => {
        const tx = {
          user: { update: async (args) => updatedUsers.push(args) },
          wallet: { update: async (args) => updatedWallets.push(args) },
        };
        return fn(tx);
      },
    };

    const report = await runCustomerIdentityMigration({ prisma: fakePrisma, apply: true });

    assert.equal(report.mode, 'apply');
    assert.equal(report.updatedUsersCount, 1);
    assert.equal(updatedUsers.length, 1);
    assert.equal(updatedUsers[0].data.phoneNumber, '+2348012345678');
    assert.equal(report.verifiedOwnershipCount, 1);
    assert.equal(report.postMigrationIntegrityOk, true);
  });

  test('flags orphaned wallets during pre-migration check', async () => {
    const fakeUsers = [
      { id: 'u1', phoneNumber: '+2348012345678', wallets: [] },
    ];
    const fakeWallets = [
      { id: 'w_orphan', userId: 'non_existent_user', phoneNumber: '+2348012345678' },
    ];

    const fakePrisma = {
      user: { findMany: async () => fakeUsers },
      wallet: { findMany: async () => fakeWallets },
    };

    const report = await runCustomerIdentityMigration({ prisma: fakePrisma, apply: false });

    assert.equal(report.orphanedWalletsCount, 1);
    assert.equal(report.preMigrationIntegrityOk, false);
    assert.equal(report.postMigrationIntegrityOk, false);
  });

  test('applyRollback restores pre-migration snapshot data', async () => {
    const snapshot = {
      userSnapshots: [{ id: 'u1', phoneNumber: '08012345678' }],
      walletSnapshots: [{ id: 'w1', phoneNumber: '08012345678' }],
    };

    const restoredUsers = [];
    const restoredWallets = [];

    const fakePrisma = {
      $transaction: async (fn) => {
        const tx = {
          user: { update: async (args) => restoredUsers.push(args) },
          wallet: { update: async (args) => restoredWallets.push(args) },
        };
        return fn(tx);
      },
    };

    const result = await applyRollback({ prisma: fakePrisma, snapshot });

    assert.equal(result.success, true);
    assert.equal(result.restoredUsersCount, 1);
    assert.equal(result.restoredWalletsCount, 1);
    assert.equal(restoredUsers[0].data.phoneNumber, '08012345678');
  });
});
