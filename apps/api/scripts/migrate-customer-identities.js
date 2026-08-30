const { canonicalizePhoneNumber } = require('../src/utils/validators');

/**
 * Customer Identity Migration Tooling with Pre/Post Validation and Rollback Support (#334).
 */
const runCustomerIdentityMigration = async ({
  prisma,
  apply = false,
  rollback = false,
  snapshot = null,
} = {}) => {
  if (rollback && snapshot) {
    return applyRollback({ prisma, snapshot });
  }

  // 1. Pre-migration scan & validation
  const users = await prisma.user.findMany({
    include: {
      wallets: true,
      transactions: { take: 1 },
      kycProfile: true,
    },
  });

  const wallets = await prisma.wallet.findMany();

  const report = {
    mode: apply ? 'apply' : 'dry-run',
    scannedUsersCount: users.length,
    scannedWalletsCount: wallets.length,
    orphanedWalletsCount: 0,
    validUsersCount: 0,
    updatedUsersCount: 0,
    collisionsCount: 0,
    verifiedOwnershipCount: 0,
    preMigrationIntegrityOk: true,
    postMigrationIntegrityOk: false,
    updates: [],
    walletUpdates: [],
    collisions: [],
    orphanedWallets: [],
    snapshot: {
      timestamp: new Date().toISOString(),
      userSnapshots: [],
      walletSnapshots: [],
    },
  };

  const userIds = new Set(users.map((u) => u.id));

  // Check for orphaned wallets
  for (const w of wallets) {
    if (!w.userId || !userIds.has(w.userId)) {
      report.orphanedWalletsCount++;
      report.orphanedWallets.push(w.id);
      report.preMigrationIntegrityOk = false;
    }
  }

  const phoneMap = new Map();

  for (const user of users) {
    const rawPhone = user.phoneNumber;
    let canonical;
    try {
      canonical = canonicalizePhoneNumber(rawPhone);
    } catch {
      canonical = null;
    }

    if (!canonical) {
      report.collisionsCount++;
      report.collisions.push({ userId: user.id, rawPhone, reason: 'invalid_format' });
      continue;
    }

    if (phoneMap.has(canonical)) {
      report.collisionsCount++;
      report.collisions.push({
        userId: user.id,
        existingUserId: phoneMap.get(canonical).id,
        canonicalPhone: canonical,
        reason: 'duplicate_canonical_identity',
      });
      continue;
    }

    phoneMap.set(canonical, user);

    if (rawPhone !== canonical) {
      report.updates.push({
        userId: user.id,
        oldPhoneNumber: rawPhone,
        newPhoneNumber: canonical,
      });

      report.snapshot.userSnapshots.push({
        id: user.id,
        phoneNumber: rawPhone,
      });

      for (const w of user.wallets || []) {
        if (w.phoneNumber !== canonical) {
          report.walletUpdates.push({
            walletId: w.id,
            oldPhoneNumber: w.phoneNumber,
            newPhoneNumber: canonical,
          });
          report.snapshot.walletSnapshots.push({
            id: w.id,
            phoneNumber: w.phoneNumber,
          });
        }
      }
    } else {
      report.validUsersCount++;
    }
  }

  // 2. Execute Migration if apply is true
  if (apply && report.updates.length > 0 && report.collisionsCount === 0) {
    await prisma.$transaction(async (tx) => {
      for (const update of report.updates) {
        await tx.user.update({
          where: { id: update.userId },
          data: { phoneNumber: update.newPhoneNumber },
        });
        report.updatedUsersCount++;
      }

      for (const wUpdate of report.walletUpdates) {
        await tx.wallet.update({
          where: { id: wUpdate.walletId },
          data: { phoneNumber: wUpdate.newPhoneNumber },
        });
      }
    });
  }

  // 3. Post-migration validation
  const postWallets = await prisma.wallet.findMany();
  let verifiedOwnership = 0;
  let ownershipMismatches = 0;

  for (const w of postWallets) {
    if (w.userId && userIds.has(w.userId)) {
      verifiedOwnership++;
    } else {
      ownershipMismatches++;
    }
  }

  report.verifiedOwnershipCount = verifiedOwnership;
  report.postMigrationIntegrityOk = ownershipMismatches === 0 && report.collisionsCount === 0;

  return report;
};

/**
 * Reverts changes from a migration snapshot backup.
 */
const applyRollback = async ({ prisma, snapshot }) => {
  if (!snapshot || !snapshot.userSnapshots) {
    throw new Error('Invalid snapshot data for rollback');
  }

  const rollbackReport = {
    restoredUsersCount: 0,
    restoredWalletsCount: 0,
    success: false,
  };

  await prisma.$transaction(async (tx) => {
    for (const u of snapshot.userSnapshots || []) {
      await tx.user.update({
        where: { id: u.id },
        data: { phoneNumber: u.phoneNumber },
      });
      rollbackReport.restoredUsersCount++;
    }

    for (const w of snapshot.walletSnapshots || []) {
      await tx.wallet.update({
        where: { id: w.id },
        data: { phoneNumber: w.phoneNumber },
      });
      rollbackReport.restoredWalletsCount++;
    }
  });

  rollbackReport.success = true;
  return rollbackReport;
};

module.exports = {
  runCustomerIdentityMigration,
  applyRollback,
};
