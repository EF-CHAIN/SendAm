const prisma = require('../common/prisma');
const logger = require('../utils/logger');
const { writeAuditLog } = require('../common/audit.service');

const DEFAULT_SUMMARY_WINDOW_DAYS = 30;
const MAX_SUMMARY_WINDOW_DAYS = 365;

const parseWindowDays = (days) => {
  const parsed = Number(days || DEFAULT_SUMMARY_WINDOW_DAYS);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_SUMMARY_WINDOW_DAYS;
  return Math.min(parsed, MAX_SUMMARY_WINDOW_DAYS);
};

const buildWalletSummary = async ({ userId, phoneNumber, windowDays }) => {
  const days = parseWindowDays(windowDays);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [wallets, transactions, kycProfile] = await Promise.all([
    prisma.wallet.findMany({
      where: { userId, chain: 'stellar' },
      include: { user: { select: { phoneNumber: true, whatsappName: true } } },
    }),
    prisma.transaction.count({ where: { userId, createdAt: { gte: since } } }),
    prisma.kycProfile.findUnique({ where: { userId } }),
  ]);

  const [successCount, failedCount, pendingCount, totalVolume] = await Promise.all([
    prisma.transaction.count({ where: { userId, status: 'success', createdAt: { gte: since } } }),
    prisma.transaction.count({ where: { userId, status: 'failed', createdAt: { gte: since } } }),
    prisma.transaction.count({ where: { userId, status: { in: ['pending', 'processing'] }, createdAt: { gte: since } } }),
    prisma.transaction.aggregate({
      where: { userId, status: 'success', createdAt: { gte: since } },
      _sum: { amount: true },
    }),
  ]);

  const recentTransactions = await prisma.transaction.findMany({
    where: { userId, createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: {
      id: true,
      type: true,
      amount: true,
      asset: true,
      status: true,
      destination: true,
      explorerUrl: true,
      createdAt: true,
    },
  });

  const trustlineStateCounts = wallets.reduce((acc, w) => {
    acc[w.trustlineState] = (acc[w.trustlineState] || 0) + 1;
    return acc;
  }, {});

  const summary = {
    userId,
    phoneNumber: phoneNumber || wallets[0]?.phoneNumber || null,
    windowDays: days,
    generatedAt: new Date().toISOString(),
    wallets: {
      total: wallets.length,
      funded: wallets.filter((w) => w.funded).length,
      byTrustlineState: trustlineStateCounts,
      keys: wallets.map((w) => ({ id: w.id, publicKey: w.publicKey, funded: w.funded, network: w.network, trustlineState: w.trustlineState })),
    },
    kyc: kycProfile ? {
      tier: kycProfile.tier,
      status: kycProfile.status,
      riskScore: kycProfile.riskScore,
      sanctionsStatus: kycProfile.sanctionsStatus,
    } : null,
    transactions: {
      total: transactions,
      success: successCount,
      failed: failedCount,
      pending: pendingCount,
      totalVolume: totalVolume._sum?.amount || '0',
    },
    recentActivity: recentTransactions.map((tx) => ({
      id: tx.id,
      type: tx.type,
      amount: tx.amount,
      asset: tx.asset,
      status: tx.status,
      destination: tx.destination,
      explorerUrl: tx.explorerUrl,
      createdAt: tx.createdAt,
    })),
  };

  return summary;
};

const getWalletActivitySummary = async ({ userId, phoneNumber, windowDays, requestingAdminId }) => {
  const resolvedUserId = userId;
  if (!resolvedUserId && phoneNumber) {
    const user = await prisma.user.findUnique({ where: { phoneNumber } });
    if (!user) throw Object.assign(new Error('User not found'), { statusCode: 404 });
    resolvedUserId = user.id;
  }

  const summary = await buildWalletSummary({ userId: resolvedUserId, phoneNumber, windowDays });

  await writeAuditLog({
    actorType: 'administrator',
    actorId: requestingAdminId,
    action: 'admin.wallet.summary.viewed',
    entityType: 'Wallet',
    entityId: resolvedUserId,
    metadata: { windowDays, phoneNumber },
  });

  return summary;
};

module.exports = {
  getWalletActivitySummary,
  buildWalletSummary,
};
