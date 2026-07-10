const { sendSuccess, sendError, sendPaginated } = require('../utils/response');
const { verifyPassword, createToken } = require('../services/adminAuth.service');
const prisma = require('../common/prisma');
const { withIdAliases } = require('../common/records');

// Parse ?page and ?limit into safe bounds so list endpoints can never be asked
// to load the entire collection at once. Defaults to 50/page, capped at 100.
const parsePagination = (query) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 50));
  return { page, limit, skip: (page - 1) * limit };
};

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
    const { page, limit, skip } = parsePagination(req.query);
    const [users, total] = await Promise.all([
      prisma.user.findMany({
        include: { wallet: { select: { publicKey: true, address: true, network: true, createdAt: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.user.count(),
    ]);
    sendPaginated(res, withIdAliases(users.map((user) => ({
      ...user,
      walletId: user.wallet,
      pinHash: undefined,
    }))), { page, limit, total });
  } catch (error) {
    next(error);
  }
};

const getWallets = async (req, res, next) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const [wallets, total] = await Promise.all([
      prisma.wallet.findMany({
        include: { user: { select: { phoneNumber: true, whatsappName: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.wallet.count(),
    ]);
    sendPaginated(res, withIdAliases(wallets.map((wallet) => ({
      ...wallet,
      encryptedSecretKey: undefined,
      userId: wallet.user,
    }))), { page, limit, total });
  } catch (error) {
    next(error);
  }
};

const getTransactions = async (req, res, next) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const [transactions, total] = await Promise.all([
      prisma.transaction.findMany({
        include: { user: { select: { phoneNumber: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.transaction.count(),
    ]);
    sendPaginated(res, withIdAliases(transactions.map((transaction) => ({
      ...transaction,
      userId: transaction.user,
    }))), { page, limit, total });
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
