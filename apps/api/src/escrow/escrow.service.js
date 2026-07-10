const config = require('../config/env');
const { executePayment } = require('../payment/payment.orchestrator');
const { writeAuditLog } = require('../common/audit.service');
const prisma = require('../common/prisma');
const { withIdAlias } = require('../common/records');

const createEscrow = async ({ creator, counterpartyId, amount, asset = 'USDC', terms, releaseAfter }) => {
  let escrow = await prisma.escrow.create({
    data: {
      creatorId: creator.id,
      counterpartyId,
      amount: String(amount),
      asset,
      chain: 'lisk',
      contractAddress: config.lisk.escrowContractAddress,
      status: 'funding',
      terms,
      releaseAfter: releaseAfter ? new Date(releaseAfter) : undefined,
    },
  });

  const payment = await executePayment({
    sender: creator,
    amount,
    asset,
    destination: config.lisk.escrowContractAddress || 'lisk-escrow-contract',
    routeType: 'escrow',
    forceRail: 'lisk',
  });

  escrow = await prisma.escrow.update({
    where: { id: escrow.id },
    data: {
      status: payment.transaction.status === 'failed' ? 'cancelled' : 'locked',
      contractEscrowId: payment.transaction.providerTransactionId || String(payment.transaction.id || payment.transaction._id),
    },
  });

  return withIdAlias(escrow);
};

const releaseEscrow = async ({ escrowId, actorId }) => {
  const escrow = await prisma.escrow.findUnique({ where: { id: escrowId } });
  if (!escrow) throw new Error('Escrow not found.');
  if (!['locked', 'disputed'].includes(escrow.status)) throw new Error('Escrow cannot be released from its current state.');

  const updated = await prisma.escrow.update({
    where: { id: escrow.id },
    data: { status: 'released' },
  });
  await prisma.transaction.create({
    data: {
      userId: escrow.creatorId,
      type: 'escrow_release',
      amount: escrow.amount,
      asset: escrow.asset,
      rail: 'lisk',
      routeType: 'escrow',
      status: 'success',
      metadata: { escrowId: escrow.id, actorId },
    },
  });
  await writeAuditLog({ actorType: 'admin', actorId, action: 'escrow.released', entityType: 'Escrow', entityId: String(escrow.id) });
  return withIdAlias(updated);
};

const refundEscrow = async ({ escrowId, actorId }) => {
  const escrow = await prisma.escrow.findUnique({ where: { id: escrowId } });
  if (!escrow) throw new Error('Escrow not found.');
  if (!['locked', 'disputed'].includes(escrow.status)) throw new Error('Escrow cannot be refunded from its current state.');

  const updated = await prisma.escrow.update({
    where: { id: escrow.id },
    data: { status: 'refunded' },
  });
  await prisma.transaction.create({
    data: {
      userId: escrow.creatorId,
      type: 'escrow_refund',
      amount: escrow.amount,
      asset: escrow.asset,
      rail: 'lisk',
      routeType: 'escrow',
      status: 'success',
      metadata: { escrowId: escrow.id, actorId },
    },
  });
  await writeAuditLog({ actorType: 'admin', actorId, action: 'escrow.refunded', entityType: 'Escrow', entityId: String(escrow.id) });
  return withIdAlias(updated);
};

const disputeEscrow = async ({ escrowId, actorId, reason }) => {
  const escrow = await prisma.escrow.findUnique({ where: { id: escrowId } });
  if (!escrow) throw new Error('Escrow not found.');
  const updated = await prisma.escrow.update({
    where: { id: escrow.id },
    data: {
      status: 'disputed',
      metadata: { ...escrow.metadata, disputeReason: reason, disputedBy: actorId },
    },
  });
  await writeAuditLog({ actorType: 'user', actorId, action: 'escrow.disputed', entityType: 'Escrow', entityId: String(escrow.id), metadata: { reason } });
  return withIdAlias(updated);
};

module.exports = {
  createEscrow,
  releaseEscrow,
  refundEscrow,
  disputeEscrow,
};
