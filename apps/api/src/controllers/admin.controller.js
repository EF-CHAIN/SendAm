const User = require('../models/User');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const { sendSuccess } = require('../utils/response');

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
    const users = await User.find().populate('walletId', 'publicKey network createdAt').sort({ createdAt: -1 });
    sendSuccess(res, users);
  } catch (error) {
    next(error);
  }
};

const getWallets = async (req, res, next) => {
  try {
    // Exclude encryptedSecretKey from output
    const wallets = await Wallet.find().select('-encryptedSecretKey').populate('userId', 'phoneNumber whatsappName').sort({ createdAt: -1 });
    sendSuccess(res, wallets);
  } catch (error) {
    next(error);
  }
};

const getTransactions = async (req, res, next) => {
  try {
    const transactions = await Transaction.find().populate('userId', 'phoneNumber').sort({ createdAt: -1 });
    sendSuccess(res, transactions);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getStats,
  getUsers,
  getWallets,
  getTransactions
};
