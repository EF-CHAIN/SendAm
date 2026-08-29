const { sendSuccess, sendError, sendPaginated } = require('../utils/response');
const { verifyPassword, createToken } = require('../services/adminAuth.service');
const prisma = require('../common/prisma');
const { withIdAliases } = require('../common/records');
const { writeAuditLog } = require('../common/audit.service');
const { userDto, walletDto, transactionDto, kycProfileDto } = require('../admin/adminDtos');

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
      pendingKyc,
      voiceCommands,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.wallet.count(),
      prisma.transaction.count(),
      prisma.transaction.count({ where: { status: 'success' } }),
      prisma.transaction.count({ where: { status: 'failed' } }),
      prisma.transaction.count({ where: { status: { in: ['pending', 'processing'] } } }),
      prisma.kycProfile.count({ where: { status: { in: ['pending', 'review'] } } }),
      prisma.voiceCommand.count(),
    ]);

    sendSuccess(res, {
      totalUsers,
      totalWallets,
      totalTransactions,
      successfulTransactions,
      failedTransactions,
      pendingTransactions,
      pendingKyc,
      voiceCommands,
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
        select: {
          id: true, phoneNumber: true, whatsappName: true, kycTier: true, createdAt: true,
          wallets: { select: { chain: true, publicKey: true, network: true, funded: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.user.count(),
    ]);
    sendPaginated(res, withIdAliases(users.map(userDto)), { page, limit, total });
  } catch (error) {
    next(error);
  }
};

const getWallets = async (req, res, next) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const [wallets, total] = await Promise.all([
      prisma.wallet.findMany({
        select: {
          id: true, chain: true, publicKey: true, funded: true, network: true, createdAt: true,
          user: { select: { id: true, phoneNumber: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.wallet.count(),
    ]);
    sendPaginated(res, withIdAliases(wallets.map(walletDto)), { page, limit, total });
  } catch (error) {
    next(error);
  }
};

const getTransactions = async (req, res, next) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const [transactions, total] = await Promise.all([
      prisma.transaction.findMany({
        select: {
          id: true, type: true, amount: true, asset: true, rail: true, routeType: true,
          status: true, destination: true, recipientPhoneNumber: true, txHash: true,
          createdAt: true, updatedAt: true,
          user: { select: { id: true, phoneNumber: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.transaction.count(),
    ]);
    sendPaginated(res, withIdAliases(transactions.map(transactionDto)), { page, limit, total });
  } catch (error) {
    next(error);
  }
};

const getKycProfiles = async (_req, res, next) => {
  try {
    const profiles = await prisma.kycProfile.findMany({
      select: {
        id: true, tier: true, status: true, country: true, riskScore: true,
        sanctionsStatus: true, sanctionsScreenedAt: true, custodyStatus: true,
        custodyReviewedAt: true, lastScreenedAt: true, createdAt: true, updatedAt: true,
        user: { select: { id: true, phoneNumber: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });
    sendSuccess(res, withIdAliases(profiles.map(kycProfileDto)));
  } catch (error) {
    next(error);
  }
};

// Full identifiers are available only through an explicit, permission-gated,
// single-record action. The response expires quickly and every reveal is
// recorded. Secrets and raw provider metadata are never revealable.
const revealSensitiveFields = async (req, res, next) => {
  try {
    const { resource, id } = req.params;
    const queries = {
      user: () => prisma.user.findUnique({ where: { id }, select: { phoneNumber: true, whatsappName: true } }),
      wallet: () => prisma.wallet.findUnique({ where: { id }, select: { publicKey: true, phoneNumber: true } }),
      transaction: () => prisma.transaction.findUnique({
        where: { id },
        select: { destination: true, recipientPhoneNumber: true, txHash: true, providerTransactionId: true },
      }),
      kyc: () => prisma.kycProfile.findUnique({
        where: { id },
        select: { providerReference: true, deniedReason: true },
      }),
    };
    if (!queries[resource]) return sendError(res, 'Unsupported reveal resource', 400);
    const fields = await queries[resource]();
    if (!fields) return sendError(res, 'Record not found', 404);

    await writeAuditLog({
      actorType: 'admin',
      actorId: req.admin?.role,
      action: 'admin.sensitive.revealed',
      entityType: resource,
      entityId: id,
      metadata: { fields: Object.keys(fields) },
      req,
    });

    return sendSuccess(res, {
      resource,
      id,
      fields,
      validUntil: new Date(Date.now() + 60_000).toISOString(),
    }, 'Sensitive fields revealed for this response only');
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
      settlementRail: 'stellar',
      custodyModel: 'direct',
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
  getKycProfiles,
  getAuditLogs,
  getSystemHealth,
  revealSensitiveFields,
};
