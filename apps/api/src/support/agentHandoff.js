const crypto = require('crypto');
const logger = require('../utils/logger');

const HANDOFF_THRESHOLD = 3;

const createCaseNumber = () => `CASE-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

const findOpenHandoff = async (prisma, userId) => prisma.supportCase.findFirst({
  where: {
    userId,
    category: 'other',
    title: 'WhatsApp customer support handoff',
    status: { not: 'closed' },
  },
  orderBy: { createdAt: 'desc' },
});

const createHandoff = async ({ prisma, user, reason }) => {
  const existing = await findOpenHandoff(prisma, user.id);
  if (existing) return existing;

  const supportCase = await prisma.supportCase.create({
    data: {
      caseNumber: createCaseNumber(),
      userId: user.id,
      category: 'other',
      title: 'WhatsApp customer support handoff',
      description: reason,
      priority: 'high',
    },
  });

  if (prisma.supportCaseComment?.create) {
    await prisma.supportCaseComment.create({
      data: {
        caseId: supportCase.id,
        authorType: 'system',
        actionType: 'escalation',
        body: reason,
      },
    });
  }
  return supportCase;
};

const handoffUnrecognizedMessage = async ({ prisma, user }) => {
  const count = (Number(user.supportUnrecognizedCount) || 0) + 1;
  await prisma.user.update({
    where: { id: user.id },
    data: { supportUnrecognizedCount: count },
  });

  if (count < HANDOFF_THRESHOLD) return { escalated: false, count };

  const supportCase = await createHandoff({
    prisma,
    user,
    reason: `Automated WhatsApp assistant could not understand three consecutive messages. Contact: ${user.phoneNumber}.`,
  });
  await prisma.user.update({
    where: { id: user.id },
    data: { supportUnrecognizedCount: 0 },
  });
  logger.info('whatsapp_support_handoff_created', {
    userId: user.id,
    caseId: supportCase.id,
    caseNumber: supportCase.caseNumber,
  });
  return { escalated: true, supportCase };
};

const handoffByRequest = async ({ prisma, user }) => {
  const supportCase = await createHandoff({
    prisma,
    user,
    reason: `Customer requested human support via WhatsApp. Contact: ${user.phoneNumber}.`,
  });
  await prisma.user.update({
    where: { id: user.id },
    data: { supportUnrecognizedCount: 0 },
  });
  return supportCase;
};

const resetUnrecognizedCount = async ({ prisma, user }) => {
  if (!Number(user.supportUnrecognizedCount)) return;
  await prisma.user.update({
    where: { id: user.id },
    data: { supportUnrecognizedCount: 0 },
  });
};

module.exports = {
  HANDOFF_THRESHOLD,
  findOpenHandoff,
  handoffUnrecognizedMessage,
  handoffByRequest,
  resetUnrecognizedCount,
};
