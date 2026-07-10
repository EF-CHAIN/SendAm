const { sendSuccess, sendError } = require('../utils/response');
const escrowService = require('./escrow.service');
const prisma = require('../common/prisma');
const { withIdAliases } = require('../common/records');

const create = async (req, res, next) => {
  try {
    const { phoneNumber, counterpartyId, amount, asset, terms, releaseAfter } = req.body;
    const user = await prisma.user.findUnique({ where: { phoneNumber } });
    if (!user) return sendError(res, 'User not found', 404);
    const escrow = await escrowService.createEscrow({ creator: user, counterpartyId, amount, asset, terms, releaseAfter });
    return sendSuccess(res, escrow, 'Escrow created', 201);
  } catch (error) {
    next(error);
  }
};

const list = async (_req, res, next) => {
  try {
    const escrows = await prisma.escrow.findMany({
      include: { creator: { select: { phoneNumber: true, whatsappName: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return sendSuccess(res, withIdAliases(escrows.map((escrow) => ({
      ...escrow,
      creatorId: escrow.creator,
    }))));
  } catch (error) {
    next(error);
  }
};

const release = async (req, res, next) => {
  try {
    const escrow = await escrowService.releaseEscrow({ escrowId: req.params.id, actorId: 'admin' });
    return sendSuccess(res, escrow, 'Escrow released');
  } catch (error) {
    next(error);
  }
};

const refund = async (req, res, next) => {
  try {
    const escrow = await escrowService.refundEscrow({ escrowId: req.params.id, actorId: 'admin' });
    return sendSuccess(res, escrow, 'Escrow refunded');
  } catch (error) {
    next(error);
  }
};

const dispute = async (req, res, next) => {
  try {
    const escrow = await escrowService.disputeEscrow({ escrowId: req.params.id, actorId: req.body.actorId, reason: req.body.reason });
    return sendSuccess(res, escrow, 'Escrow disputed');
  } catch (error) {
    next(error);
  }
};

module.exports = {
  create,
  list,
  release,
  refund,
  dispute,
};
