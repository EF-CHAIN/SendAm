const crypto = require('crypto');
const prisma = require('../common/prisma');

const CONFIRMATION_TTL_MS = 10 * 60 * 1000;
const makeReference = () => crypto.randomBytes(3).toString('hex').toUpperCase();
const makeSummaryHash = ({ amount, asset, destination, routeType }) => crypto
  .createHash('sha256')
  .update(JSON.stringify({ amount: String(amount), asset: String(asset).toUpperCase(), destination: String(destination).trim(), routeType: String(routeType) }))
  .digest('hex');

const createConfirmationService = (db = prisma, { now = () => new Date() } = {}) => ({
  async create({ userId, amount, asset, destination, recipientLabel, routeType }) {
    const currentTime = now();
    return db.$transaction(async (tx) => {
      // This update locks the user row, ordering concurrent confirmation
      // requests so the newest always supersedes every older pending request.
      const versionedUser = await tx.user.update({
        where: { id: userId },
        data: { confirmationVersion: { increment: 1 } },
        select: { confirmationVersion: true },
      });
      await tx.paymentConfirmation.updateMany({
        where: { userId, state: 'pending' },
        data: { state: 'superseded', cancelledAt: currentTime },
      });
      return tx.paymentConfirmation.create({
        data: {
          userId,
          nonce: crypto.randomUUID(),
          reference: makeReference(),
          version: versionedUser.confirmationVersion,
          summaryHash: makeSummaryHash({ amount, asset, destination, routeType }),
          amount: String(amount),
          asset: String(asset).toUpperCase(),
          destination: String(destination).trim(),
          recipientLabel,
          routeType,
          expiresAt: new Date(currentTime.getTime() + CONFIRMATION_TTL_MS),
        },
      });
    });
  },
  find(userId, reference) {
    return db.paymentConfirmation.findUnique({ where: { userId_reference: { userId, reference: String(reference).toUpperCase() } } });
  },
  async hasPending(userId) {
    return (await db.paymentConfirmation.count({ where: { userId, state: 'pending' } })) > 0;
  },
  async cancel(record) {
    const result = await db.paymentConfirmation.updateMany({
      where: { id: record.id, state: 'pending' },
      data: { state: 'cancelled', cancelledAt: now() },
    });
    return result.count === 1;
  },
  expire(record) {
    return db.paymentConfirmation.updateMany({
      where: { id: record.id, state: 'pending' },
      data: { state: 'expired', cancelledAt: now() },
    });
  },
  async authorize(record) {
    const result = await db.paymentConfirmation.updateMany({
      where: { id: record.id, state: 'pending', summaryHash: record.summaryHash, expiresAt: { gt: now() } },
      data: { state: 'authorized', authorizedAt: now() },
    });
    return result.count === 1;
  },
  complete(id, transactionId) {
    return db.paymentConfirmation.update({ where: { id }, data: { state: 'completed', transactionId } });
  },
});

module.exports = { CONFIRMATION_TTL_MS, makeSummaryHash, createConfirmationService, confirmationService: createConfirmationService() };
