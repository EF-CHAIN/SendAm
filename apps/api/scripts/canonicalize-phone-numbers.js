const { canonicalizePhoneNumber } = require('../src/utils/validators');

/**
 * Migration tooling for phone number canonicalization (#153, #180).
 *
 * Scans primary User/Wallet records and secondary/historical phone-bearing fields:
 * - User.phoneNumber & Wallet.phoneNumber
 * - Contact.phoneNumber (with ownerId collision checks)
 * - Transaction.recipientPhoneNumber
 * - VoiceCommand.phoneNumber
 * - SimMessage.phoneNumber
 * - Notification.recipient
 * - Alias.target (where targetType === 'phone')
 *
 * Detects equivalent phone number formats and reports collisions without
 * silently merging financial identities or violating unique constraints.
 */
const runPhoneCanonicalization = async ({ prisma, apply = false } = {}) => {
  const users = await prisma.user.findMany({
    include: {
      wallets: true,
      transactions: { take: 1 },
      kycProfile: true,
    },
  });

  const report = {
    scannedUsersCount: users.length,
    alreadyCanonicalCount: 0,
    updatedUsersCount: 0,
    invalidPhoneCount: 0,
    collisionsCount: 0,
    crossModelUpdatesCount: 0,
    dryRun: !apply,
    invalidUsers: [],
    collisions: [],
    updates: [],
    secondaryUpdates: {
      contacts: [],
      transactions: [],
      voiceCommands: [],
      simMessages: [],
      notifications: [],
      aliases: [],
    },
    contactCollisions: [],
  };

  const canonicalGroups = new Map();

  for (const user of users) {
    let canonical;
    try {
      canonical = canonicalizePhoneNumber(user.phoneNumber);
    } catch (err) {
      report.invalidPhoneCount += 1;
      report.invalidUsers.push({
        id: user.id,
        phoneNumber: user.phoneNumber,
        error: err.message,
      });
      continue;
    }

    if (canonical === user.phoneNumber) {
      report.alreadyCanonicalCount += 1;
    }

    if (!canonicalGroups.has(canonical)) {
      canonicalGroups.set(canonical, []);
    }
    canonicalGroups.get(canonical).push({
      ...user,
      canonicalPhone: canonical,
      hasFinancialState: Boolean(
        user.wallets?.length > 0 ||
        user.transactions?.length > 0 ||
        user.pinHash ||
        user.kycProfile
      ),
    });
  }

  for (const [canonicalPhone, groupUsers] of canonicalGroups.entries()) {
    if (groupUsers.length > 1) {
      const financialUsers = groupUsers.filter((u) => u.hasFinancialState);

      report.collisionsCount += 1;
      report.collisions.push({
        canonicalPhone,
        totalUsers: groupUsers.length,
        financialUsersCount: financialUsers.length,
        requiresManualReview: true,
        users: groupUsers.map((u) => ({
          id: u.id,
          phoneNumber: u.phoneNumber,
          hasWallets: u.wallets?.length || 0,
          hasTransactions: u.transactions?.length || 0,
          hasPin: Boolean(u.pinHash),
          kycTier: u.kycTier,
        })),
      });
    } else {
      const user = groupUsers[0];
      if (user.phoneNumber !== canonicalPhone) {
        report.updates.push({
          userId: user.id,
          oldPhoneNumber: user.phoneNumber,
          newPhoneNumber: canonicalPhone,
        });
      }
    }
  }

  // --- Cross-model phone field scanning (#180) ---

  // 1. Contact.phoneNumber
  if (prisma.contact) {
    const contacts = await prisma.contact.findMany();
    const ownerContactMap = new Map(); // ownerId -> Map(canonical -> array)

    for (const contact of contacts) {
      try {
        const canonical = canonicalizePhoneNumber(contact.phoneNumber);
        const ownerKey = contact.ownerId;
        if (!ownerContactMap.has(ownerKey)) ownerContactMap.set(ownerKey, new Map());
        const canonMap = ownerContactMap.get(ownerKey);

        if (!canonMap.has(canonical)) canonMap.set(canonical, []);
        canonMap.get(canonical).push({ ...contact, canonicalPhone: canonical });
      } catch {
        // Skip invalid contact phone format
      }
    }

    for (const [ownerId, canonMap] of ownerContactMap.entries()) {
      for (const [canonical, group] of canonMap.entries()) {
        if (group.length > 1) {
          report.contactCollisions.push({
            ownerId,
            canonicalPhone: canonical,
            requiresManualReview: true,
            contacts: group.map((c) => ({ id: c.id, phoneNumber: c.phoneNumber })),
          });
        } else {
          const contact = group[0];
          if (contact.phoneNumber !== canonical) {
            report.secondaryUpdates.contacts.push({
              id: contact.id,
              oldPhoneNumber: contact.phoneNumber,
              newPhoneNumber: canonical,
            });
          }
        }
      }
    }
  }

  // 2. Transaction.recipientPhoneNumber
  if (prisma.transaction) {
    const transactions = await prisma.transaction.findMany({
      where: { recipientPhoneNumber: { not: null } },
    });
    for (const tx of transactions) {
      if (!tx.recipientPhoneNumber) continue;
      try {
        const canonical = canonicalizePhoneNumber(tx.recipientPhoneNumber);
        if (canonical !== tx.recipientPhoneNumber) {
          report.secondaryUpdates.transactions.push({
            id: tx.id,
            oldPhoneNumber: tx.recipientPhoneNumber,
            newPhoneNumber: canonical,
          });
        }
      } catch {
        // preserve non-phone recipient values as-is
      }
    }
  }

  // 3. VoiceCommand.phoneNumber
  if (prisma.voiceCommand) {
    const vcList = await prisma.voiceCommand.findMany();
    for (const vc of vcList) {
      try {
        const canonical = canonicalizePhoneNumber(vc.phoneNumber);
        if (canonical !== vc.phoneNumber) {
          report.secondaryUpdates.voiceCommands.push({
            id: vc.id,
            oldPhoneNumber: vc.phoneNumber,
            newPhoneNumber: canonical,
          });
        }
      } catch {
        // skip invalid
      }
    }
  }

  // 4. SimMessage.phoneNumber
  if (prisma.simMessage) {
    const simList = await prisma.simMessage.findMany();
    for (const sm of simList) {
      try {
        const canonical = canonicalizePhoneNumber(sm.phoneNumber);
        if (canonical !== sm.phoneNumber) {
          report.secondaryUpdates.simMessages.push({
            id: sm.id,
            oldPhoneNumber: sm.phoneNumber,
            newPhoneNumber: canonical,
          });
        }
      } catch {
        // skip invalid
      }
    }
  }

  // 5. Notification.recipient
  if (prisma.notification) {
    const notifs = await prisma.notification.findMany();
    for (const n of notifs) {
      try {
        const canonical = canonicalizePhoneNumber(n.recipient);
        if (canonical !== n.recipient) {
          report.secondaryUpdates.notifications.push({
            id: n.id,
            oldRecipient: n.recipient,
            newRecipient: canonical,
          });
        }
      } catch {
        // skip non-phone recipients
      }
    }
  }

  // 6. Alias.target (where targetType === 'phone')
  if (prisma.alias) {
    const aliases = await prisma.alias.findMany({
      where: { targetType: 'phone' },
    });
    for (const a of aliases) {
      try {
        const canonical = canonicalizePhoneNumber(a.target);
        if (canonical !== a.target) {
          report.secondaryUpdates.aliases.push({
            id: a.id,
            oldTarget: a.target,
            newTarget: canonical,
          });
        }
      } catch {
        // skip invalid
      }
    }
  }

  const totalSecondary =
    report.secondaryUpdates.contacts.length +
    report.secondaryUpdates.transactions.length +
    report.secondaryUpdates.voiceCommands.length +
    report.secondaryUpdates.simMessages.length +
    report.secondaryUpdates.notifications.length +
    report.secondaryUpdates.aliases.length;

  report.crossModelUpdatesCount = totalSecondary;

  if (apply) {
    // Apply primary user/wallet updates
    if (report.updates.length > 0) {
      for (const update of report.updates) {
        await prisma.$transaction(async (tx) => {
          await tx.user.update({
            where: { id: update.userId },
            data: { phoneNumber: update.newPhoneNumber },
          });
          await tx.wallet.updateMany({
            where: { userId: update.userId },
            data: { phoneNumber: update.newPhoneNumber },
          });
        });
        report.updatedUsersCount += 1;
      }
    }

    // Apply secondary cross-model updates
    if (totalSecondary > 0) {
      await prisma.$transaction(async (tx) => {
        for (const c of report.secondaryUpdates.contacts) {
          await tx.contact.update({ where: { id: c.id }, data: { phoneNumber: c.newPhoneNumber } });
        }
        for (const t of report.secondaryUpdates.transactions) {
          await tx.transaction.update({ where: { id: t.id }, data: { recipientPhoneNumber: t.newPhoneNumber } });
        }
        for (const vc of report.secondaryUpdates.voiceCommands) {
          await tx.voiceCommand.update({ where: { id: vc.id }, data: { phoneNumber: vc.newPhoneNumber } });
        }
        for (const sm of report.secondaryUpdates.simMessages) {
          await tx.simMessage.update({ where: { id: sm.id }, data: { phoneNumber: sm.newPhoneNumber } });
        }
        for (const n of report.secondaryUpdates.notifications) {
          await tx.notification.update({ where: { id: n.id }, data: { recipient: n.newRecipient } });
        }
        for (const a of report.secondaryUpdates.aliases) {
          await tx.alias.update({ where: { id: a.id }, data: { target: a.newTarget } });
        }
      });
    }
  }

  return report;
};

const run = async () => {
  const prisma = require('../src/common/prisma');
  const apply = process.argv.includes('--apply');
  try {
    const report = await runPhoneCanonicalization({ prisma, apply });
    console.log(JSON.stringify(report, null, 2));
    if (report.collisionsCount > 0 || report.contactCollisions.length > 0) {
      console.warn(`WARNING: Collisions detected! Manual review required.`);
    }
  } catch (error) {
    console.error('Migration failed:', error);
    process.exitCode = 1;
  }
};

if (require.main === module) run();

module.exports = {
  runPhoneCanonicalization,
};
