const { createKeypair } = require('./stellar.service');
const { encrypt } = require('./crypto.service');
const Wallet = require('../models/Wallet');
const User = require('../models/User');

const createWalletForUser = async (userId) => {
  const existingWallet = await Wallet.findOne({ userId });
  if (existingWallet) {
    throw new Error('User already has a wallet');
  }

  const { publicKey, secretKey } = createKeypair();
  const encryptedSecretKey = encrypt(secretKey);

  const wallet = await Wallet.create({
    userId,
    publicKey,
    encryptedSecretKey,
  });

  await User.findByIdAndUpdate(userId, { walletId: wallet._id });

  return wallet;
};

const getWalletByUserId = async (userId) => {
  return await Wallet.findOne({ userId });
};

// Mark a wallet as funded once Friendbot has confirmed the account exists.
// Returns the updated wallet so callers can use the fresh state.
const markWalletFunded = async (walletId) => {
  return await Wallet.findByIdAndUpdate(walletId, { funded: true }, { new: true });
};

const getWalletByPhoneNumber = async (phoneNumber) => {
  const user = await User.findOne({ phoneNumber }).populate('walletId');
  if (!user || !user.walletId) {
    return null;
  }
  return user.walletId;
};

module.exports = {
  createWalletForUser,
  getWalletByUserId,
  getWalletByPhoneNumber,
  markWalletFunded,
};
