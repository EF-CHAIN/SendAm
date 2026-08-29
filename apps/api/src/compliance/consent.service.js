const OPT_OUT_KEYWORDS = new Set(['STOP', 'UNSUBSCRIBE', 'CANCEL ALL', 'OPT OUT', 'QUIT', 'END']);
const OPT_IN_KEYWORDS = new Set(['START', 'UNSTOP', 'SUBSCRIBE', 'OPT IN']);

const parseConsentCommand = (text) => {
  const normalized = String(text || '').trim().toUpperCase();
  if (OPT_OUT_KEYWORDS.has(normalized)) {
    return { isConsentCommand: true, consent: 'opted_out', command: normalized };
  }
  if (OPT_IN_KEYWORDS.has(normalized)) {
    return { isConsentCommand: true, consent: 'opted_in', command: normalized };
  }
  return { isConsentCommand: false };
};

const updateUserConsent = async ({ userId, phoneNumber, consent, source = 'whatsapp_keyword', prisma = null }) => {
  const db = prisma || require('../common/prisma');
  const now = new Date();

  const user = await db.user.update({
    where: { id: userId },
    data: {
      messagingConsent: consent,
      consentSource: source,
      consentUpdatedAt: now,
    },
  });

  try {
    await db.auditLog.create({
      data: {
        actorType: 'user',
        actorId: userId,
        action: 'messaging_consent_updated',
        entityType: 'User',
        entityId: userId,
        metadata: {
          phoneNumber: phoneNumber || user.phoneNumber,
          consent,
          source,
          updatedAt: now.toISOString(),
        },
      },
    });
  } catch (auditError) {
    // Non-blocking for notification workflow, log failure if needed
  }

  return user;
};

const isMessageAllowed = ({ user, isTransactional = false, messageCategory = 'promotional' }) => {
  if (isTransactional || messageCategory === 'transactional' || messageCategory === 'essential') {
    return true;
  }
  if (user && user.messagingConsent === 'opted_out') {
    return false;
  }
  return true;
};

module.exports = {
  parseConsentCommand,
  updateUserConsent,
  isMessageAllowed,
  OPT_OUT_KEYWORDS,
  OPT_IN_KEYWORDS,
};
