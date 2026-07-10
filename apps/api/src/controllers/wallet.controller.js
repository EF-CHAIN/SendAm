const { isValidPhoneNumber, isValidAmount } = require('../utils/validators');
const { sendSuccess, sendError } = require('../utils/response');
const walletService = require('../wallet/wallet.service');
const { executePayment } = require('../payment/payment.orchestrator');
const prisma = require('../common/prisma');

const createWallet = async (req, res, next) => {
  try {
    const { phoneNumber } = req.body;
    if (!isValidPhoneNumber(phoneNumber)) return sendError(res, 'A valid phone number is required');

    let user = await prisma.user.findUnique({ where: { phoneNumber } });
    if (!user) {
      user = await prisma.user.create({ data: { phoneNumber } });
    }

    const wallet = await walletService.createOrGetWallet({ user });

    return sendSuccess(res, {
      walletId: wallet._id,
      address: wallet.address || wallet.publicKey,
      provider: wallet.provider,
      primaryChain: wallet.primaryChain,
      supportedChains: wallet.supportedChains,
    }, 'Managed wallet is ready', 201);
  } catch (error) {
    next(error);
  }
};

const checkBalance = async (req, res, next) => {
  try {
    const { phone } = req.params;
    if (!isValidPhoneNumber(phone)) return sendError(res, 'A valid phone number is required');

    const wallet = await walletService.getWalletByPhoneNumber(phone);
    if (!wallet) return sendError(res, 'Wallet not found for this phone number', 404);

    const balance = await walletService.balance({ wallet });
    return sendSuccess(res, { balance, address: wallet.address || wallet.publicKey }, 'Balance fetched successfully');
  } catch (error) {
    next(error);
  }
};

const sendFunds = async (req, res, next) => {
  try {
    const { phoneNumber, amount, destination } = req.body;

    if (!isValidPhoneNumber(phoneNumber) || !isValidAmount(amount) || !destination) {
      return sendError(res, 'A valid phone number, amount, and destination are required');
    }

    const user = await prisma.user.findUnique({ where: { phoneNumber } });
    if (!user) return sendError(res, 'User not found', 404);

    const result = await executePayment({
      sender: user,
      destination,
      amount,
      asset: req.body.asset || 'USDC',
      routeType: req.body.routeType,
      sourceCountry: req.body.sourceCountry,
      destinationCountry: req.body.destinationCountry,
    });

    return sendSuccess(res, {
      transactionId: result.transaction._id,
      status: result.transaction.status,
      rail: result.transaction.rail,
      receipt: result.receipt,
    }, 'Payment accepted');
  } catch (error) {
    next(error);
  }
};

const getTransactionHistory = async (req, res, next) => {
  try {
    const { phone } = req.params;
    if (!isValidPhoneNumber(phone)) return sendError(res, 'A valid phone number is required');

    const user = await prisma.user.findUnique({ where: { phoneNumber: phone } });
    if (!user) return sendError(res, 'User not found', 404);

    const history = await walletService.transactionHistory({ userId: user.id });
    return sendSuccess(res, history);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createWallet,
  checkBalance,
  sendFunds,
  getTransactionHistory,
};
