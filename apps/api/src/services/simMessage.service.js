const prisma = require('../common/prisma');

/**
 * Data-access layer for the `SimMessage` table (see docs/CHAT-SIM.md). The
 * only place chat-sim rows are read or written — sim.controller.js (#10) and
 * the sim transport (#8) go through these functions instead of touching
 * Prisma directly.
 */

const appendMessage = ({ phoneNumber, direction, text }) =>
  prisma.simMessage.create({ data: { phoneNumber, direction, text } });

const listMessages = (phoneNumber) =>
  prisma.simMessage.findMany({
    where: { phoneNumber },
    orderBy: { createdAt: 'asc' },
  });

const listMessagesSince = (phoneNumber, since) =>
  prisma.simMessage.findMany({
    where: { phoneNumber, createdAt: { gt: new Date(since) } },
    orderBy: { createdAt: 'asc' },
  });

module.exports = {
  appendMessage,
  listMessages,
  listMessagesSince,
};
