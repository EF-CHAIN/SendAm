const { createWalletForUser, getWalletByPhoneNumber, getWalletByUserId } = require('../services/wallet.service');
const { getBalance, sendXlm, fundAccount } = require('../services/stellar.service');
const { decrypt } = require('../services/crypto.service');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { sendSuccess, sendError } = require('../utils/response');

const createWallet = async (req, res, next) => {
  try {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return sendError(res, 'Phone number is required');

    let user = await User.findOne({ phoneNumber });
    if (!user) {
      user = await User.create({ phoneNumber });
    }

    try {
      const wallet = await createWalletForUser(user._id);
      
      // Attempt to fund testnet
      await fundAccount(wallet.publicKey);
      
      return sendSuccess(res, {
        publicKey: wallet.publicKey,
        network: wallet.network
      }, 'Wallet created and funded successfully', 201);
    } catch (err) {
      if (err.message === 'User already has a wallet') {
        const existingWallet = await getWalletByUserId(user._id);
        return sendSuccess(res, {
          publicKey: existingWallet.publicKey,
          network: existingWallet.network
        }, 'Wallet already exists');
      }
      throw err;
    }
  } catch (error) {
    next(error);
  }
};

const checkBalance = async (req, res, next) => {
  try {
    const { phone } = req.params;
    if (!phone) return sendError(res, 'Phone number is required');

    const wallet = await getWalletByPhoneNumber(phone);
    if (!wallet) return sendError(res, 'Wallet not found for this phone number', 404);

    const balance = await getBalance(wallet.publicKey);
    return sendSuccess(res, { balance, publicKey: wallet.publicKey }, 'Balance fetched successfully');
  } catch (error) {
    next(error);
  }
};

const sendFunds = async (req, res, next) => {
  try {
    const { phoneNumber, amount, destination } = req.body;
    
    if (!phoneNumber || !amount || !destination) {
      return sendError(res, 'Phone number, amount, and destination are required');
    }

    const user = await User.findOne({ phoneNumber });
    if (!user) return sendError(res, 'User not found', 404);

    const wallet = await getWalletByUserId(user._id);
    if (!wallet) return sendError(res, 'Wallet not found', 404);

    const secretKey = decrypt(wallet.encryptedSecretKey);
    const txResponse = await sendXlm(secretKey, destination, amount);

    await Transaction.create({
      userId: user._id,
      type: 'send',
      amount,
      asset: 'XLM',
      destination,
      txHash: txResponse.hash,
      status: 'success'
    });

    return sendSuccess(res, { txHash: txResponse.hash }, 'Transaction successful');
  } catch (error) {
    // Record failed transaction if user is found
    if (req.body.phoneNumber) {
      const user = await User.findOne({ phoneNumber: req.body.phoneNumber });
      if (user) {
        await Transaction.create({
          userId: user._id,
          type: 'send',
          amount: req.body.amount || '0',
          destination: req.body.destination || 'unknown',
          status: 'failed'
        });
      }
    }
    
    return sendError(res, error.message || 'Transaction failed');
  }
};

module.exports = {
  createWallet,
  checkBalance,
  sendFunds
};
