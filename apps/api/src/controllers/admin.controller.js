const User = require('../models/User');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const { sendSuccess, sendError, sendPaginated } = require('../utils/response');
const { verifyPassword, createToken } = require('../services/adminAuth.service');

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
    const totalUsers = await User.countDocuments();
    const totalWallets = await Wallet.countDocuments();
    const totalTransactions = await Transaction.countDocuments();
    const successfulTransactions = await Transaction.countDocuments({ status: 'success' });
    const failedTransactions = await Transaction.countDocuments({ status: 'failed' });

    sendSuccess(res, {
      totalUsers,
      totalWallets,
      totalTransactions,
      successfulTransactions,
      failedTransactions
    });
  } catch (error) {
    next(error);
  }
};

const getUsers = async (req, res, next) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const [users, total] = await Promise.all([
      User.find().sort({ createdAt: -1 }).skip(skip).limit(limit),
      User.countDocuments(),
    ]);

    // Wallets are looked up separately and attached to the response rather
    // than populated — a user can now have one wallet per chain, so there's
    // no single ref on User to populate (see models/User.js).
    const userIds = users.map((u) => u._id);
    const wallets = await Wallet.find({ userId: { $in: userIds } }).select('userId chain publicKey network createdAt');
    const walletsByUser = wallets.reduce((acc, w) => {
      const key = String(w.userId);
      (acc[key] = acc[key] || []).push(w);
      return acc;
    }, {});

    const usersWithWallets = users.map((u) => ({
      ...u.toObject(),
      wallets: walletsByUser[String(u._id)] || [],
    }));

    sendPaginated(res, usersWithWallets, { page, limit, total });
  } catch (error) {
    next(error);
  }
};

const getWallets = async (req, res, next) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const [wallets, total] = await Promise.all([
      // Exclude encryptedSecretKey from output
      Wallet.find().select('-encryptedSecretKey').populate('userId', 'phoneNumber whatsappName').sort({ createdAt: -1 }).skip(skip).limit(limit),
      Wallet.countDocuments(),
    ]);
    sendPaginated(res, wallets, { page, limit, total });
  } catch (error) {
    next(error);
  }
};

const getTransactions = async (req, res, next) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const [transactions, total] = await Promise.all([
      Transaction.find().populate('userId', 'phoneNumber').sort({ createdAt: -1 }).skip(skip).limit(limit),
      Transaction.countDocuments(),
    ]);
    sendPaginated(res, transactions, { page, limit, total });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  login,
  getStats,
  getUsers,
  getWallets,
  getTransactions
};
