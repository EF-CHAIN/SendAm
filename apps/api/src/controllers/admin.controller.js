const { sendSuccess, sendError } = require('../utils/response');
const { verifyPassword, createToken } = require('../services/adminAuth.service');
const prisma = require('../common/prisma');
const { withIdAliases } = require('../common/records');

const login = async (req, res, next) => {
  try {
    const { password } = req.body || {};
    if (!verifyPassword(password)) {
      return sendError(res, 'Invalid credentials', 401);
    }
    const token = createToken();
    return sendSuccess(res, { token }, 'Login successful');
  } catch (error) {
    next(error);
  }
};

const getStats = async (req, res, next) => {
  try {
    const [
      totalUsers,
      totalWallets,
      totalTransactions,
      successfulTransactions,
      failedTransactions,
      pendingTransactions,
      openEscrows,
      pendingKyc,
      voiceCommands,
      activeCashoutLocations,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.wallet.count(),
      prisma.transaction.count(),
      prisma.transaction.count({ where: { status: 'success' } }),
      prisma.transaction.count({ where: { status: 'failed' } }),
      prisma.transaction.count({ where: { status: { in: ['pending', 'processing'] } } }),
      prisma.escrow.count({ where: { status: { in: ['funding', 'locked', 'disputed'] } } }),
      prisma.kycProfile.count({ where: { status: { in: ['pending', 'review'] } } }),
      prisma.voiceCommand.count(),
      prisma.cashoutLocation.count({ where: { status: 'active' } }),
    ]);

    sendSuccess(res, {
      totalUsers,
      totalWallets,
      totalTransactions,
      successfulTransactions,
      failedTransactions,
      pendingTransactions,
      openEscrows,
      pendingKyc,
      voiceCommands,
      activeCashoutLocations,
    });
  } catch (error) {
    next(error);
  }
};

const getUsers = async (req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      include: { wallet: { select: { publicKey: true, address: true, network: true, createdAt: true } } },
      orderBy: { createdAt: 'desc' },
    });
    sendSuccess(res, withIdAliases(users.map((user) => ({
      ...user,
      walletId: user.wallet,
      pinHash: undefined,
    }))));
  } catch (error) {
    next(error);
  }
};

const getWallets = async (req, res, next) => {
  try {
    const wallets = await prisma.wallet.findMany({
      include: { user: { select: { phoneNumber: true, whatsappName: true } } },
      orderBy: { createdAt: 'desc' },
    });
    sendSuccess(res, withIdAliases(wallets.map((wallet) => ({
      ...wallet,
      encryptedSecretKey: undefined,
      userId: wallet.user,
    }))));
  } catch (error) {
    next(error);
  }
};

const getTransactions = async (req, res, next) => {
  try {
    const transactions = await prisma.transaction.findMany({
      include: { user: { select: { phoneNumber: true } } },
      orderBy: { createdAt: 'desc' },
    });
    sendSuccess(res, withIdAliases(transactions.map((transaction) => ({
      ...transaction,
      userId: transaction.user,
    }))));
  } catch (error) {
    next(error);
  }
};

const getEscrows = async (_req, res, next) => {
  try {
    const escrows = await prisma.escrow.findMany({
      include: { creator: { select: { phoneNumber: true, whatsappName: true } } },
      orderBy: { createdAt: 'desc' },
    });
    sendSuccess(res, withIdAliases(escrows.map((escrow) => ({
      ...escrow,
      creatorId: escrow.creator,
    }))));
  } catch (error) {
    next(error);
  }
};

const getKycProfiles = async (_req, res, next) => {
  try {
    const profiles = await prisma.kycProfile.findMany({
      include: { user: { select: { phoneNumber: true, whatsappName: true } } },
      orderBy: { updatedAt: 'desc' },
    });
    sendSuccess(res, withIdAliases(profiles.map((profile) => ({
      ...profile,
      userId: profile.user,
    }))));
  } catch (error) {
    next(error);
  }
};

const getAuditLogs = async (_req, res, next) => {
  try {
    const logs = await prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    sendSuccess(res, withIdAliases(logs));
  } catch (error) {
    next(error);
  }
};

const getSystemHealth = async (_req, res, next) => {
  try {
    sendSuccess(res, {
      api: 'ok',
      database: 'ok',
      queues: process.env.REDIS_URL || process.env.UPSTASH_REDIS_URL ? 'redis-configured' : 'inline-dev-mode',
      primarySettlement: 'lisk',
      corridorRail: 'stellar',
      walletProvider: process.env.WALLET_PROVIDER || 'thirdweb',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  login,
  getStats,
  getUsers,
  getWallets,
  getTransactions,
  getEscrows,
  getKycProfiles,
  getAuditLogs,
  getSystemHealth,
};
