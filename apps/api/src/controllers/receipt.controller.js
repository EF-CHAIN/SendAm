const prisma = require('../common/prisma');
const { sendSuccess, sendError } = require('../utils/response');

const maskValue = (value) => {
  if (!value) return null;
  if (value.length <= 7) return '***';
  return value.slice(0, 4) + '*'.repeat(value.length - 8) + value.slice(-4);
};

const verifyReceipt = async (req, res, next) => {
  try {
    const rawId = req.params.id || '';
    const transactionId = rawId.startsWith('SDA-') ? rawId.slice(4) : rawId;

    const transaction = await prisma.transaction.findUnique({
      where: { id: transactionId },
      include: {
        user: {
          select: {
            phoneNumber: true,
          },
        },
      },
    });

    if (!transaction) {
      return sendError(res, 'Receipt not found', 404);
    }

    const metadata = transaction.metadata || {};

    // Mask sensitive identifiers (parties) for privacy-safe verification
    const senderMasked = maskValue(transaction.user?.phoneNumber);
    const recipientMasked = transaction.recipientPhoneNumber
      ? maskValue(transaction.recipientPhoneNumber)
      : (transaction.destination ? maskValue(transaction.destination) : null);

    const receipt = {
      receiptId: `SDA-${transaction.id}`,
      transactionHash: transaction.txHash || 'pending',
      asset: transaction.asset,
      amount: transaction.amount,
      fee: metadata.fee || '0.00',
      parties: {
        sender: senderMasked,
        recipient: recipientMasked,
      },
      status: transaction.status,
      timestamp: transaction.createdAt.toISOString(),
      quoteId: transaction.quoteId,
    };

    return sendSuccess(res, { receipt }, 'Receipt verified successfully');
  } catch (error) {
    next(error);
  }
};

module.exports = {
  verifyReceipt,
};