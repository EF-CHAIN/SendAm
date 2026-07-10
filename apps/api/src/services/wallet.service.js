const { resolveAdapter, SUPPORTED_CHAINS } = require('./chains');
const { encrypt } = require('./crypto.service');
const Wallet = require('../models/Wallet');
const User = require('../models/User');

const createWalletForUser = async (userId, chain) => {
  const existingWallet = await Wallet.findOne({ userId, chain });
  if (existingWallet) {
    throw new Error('User already has a wallet on this chain');
  }

  const { publicKey, secretKey } = resolveAdapter(chain).createWallet();
  const encryptedSecretKey = encrypt(secretKey);

  return Wallet.create({
    userId,
    chain,
    publicKey,
    encryptedSecretKey,
  });
};

const getWalletsByUserId = async (userId) => {
  return Wallet.find({ userId });
};

const getWalletByUserIdAndChain = async (userId, chain) => {
  return Wallet.findOne({ userId, chain });
};

// Mark a wallet as funded once the chain has confirmed the account is
// usable (Friendbot on Stellar; a balance check on Lisk, since there's no
// auto-fund API to confirm against). Returns the updated wallet so callers
// can use the fresh state.
const markWalletFunded = async (walletId) => {
  return Wallet.findByIdAndUpdate(walletId, { funded: true }, { new: true });
};

const getWalletsByPhoneNumber = async (phoneNumber) => {
  const user = await User.findOne({ phoneNumber });
  if (!user) return [];
  return getWalletsByUserId(user._id);
};

module.exports = {
  SUPPORTED_CHAINS,
  createWalletForUser,
  getWalletsByUserId,
  getWalletByUserIdAndChain,
  getWalletsByPhoneNumber,
  markWalletFunded,
};
