const {
  STATUS,
  CATEGORIES,
  CATEGORY_NAMES,
  SOURCES,
  isKnownCategory,
  isRequiredCategory,
  buildConsentState,
  isMessagePermitted,
  categoriesForKeyword,
} = require('./messagingConsent');

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

/**
 * Legacy category names still used by existing call sites, mapped onto the
 * category set in `messagingConsent.js`. Kept as a translation layer rather
 * than a rename so no send path changes behaviour in this commit.
 */
const LEGACY_CATEGORY_ALIASES = {
  essential: 'transactional',
  promotional: 'marketing',
};

const normalizeCategory = (messageCategory, isTransactional) => {
  if (isTransactional) return 'transactional';
  const raw = String(messageCategory || 'marketing');
  return LEGACY_CATEGORY_ALIASES[raw] || raw;
};

/**
 * Whether a message may be sent. Boolean, for the existing call sites.
 *
 * `consentRecords` is optional: without it this falls back to the legacy
 * global flag plus the category default, which is exactly the previous
 * behaviour for transactional and opted-out cases.
 */
const isMessageAllowed = ({
  user,
  isTransactional = false,
  messageCategory = 'promotional',
  consentRecords = [],
}) => {
  const category = normalizeCategory(messageCategory, isTransactional);
  return isMessagePermitted({ category, user, records: consentRecords }).permitted;
};

/**
 * Load a user's consent records and decide, in one call, whether a category
 * may be sent — the form the notification path should use, since it is the
 * only one that consults per-category opt-outs.
 */
const checkMessagePermission = async ({ userId, user = null, category, prisma = null }) => {
  const db = prisma || require('../common/prisma');
  const [subject, records] = await Promise.all([
    user || db.user.findUnique({ where: { id: userId } }),
    db.messagingConsentRecord.findMany({ where: { userId } }),
  ]);
  return isMessagePermitted({ category, user: subject, records });
};

/**
 * Read the full consent picture for a user. This is what support sees, and it
 * lists every category — including ones never explicitly set — so an agent can
 * tell "denied" apart from "never asked".
 */
const getConsentState = async ({ userId, prisma = null }) => {
  const db = prisma || require('../common/prisma');
  const [user, records] = await Promise.all([
    db.user.findUnique({ where: { id: userId } }),
    db.messagingConsentRecord.findMany({ where: { userId } }),
  ]);
  return {
    userId,
    globalConsent: user?.messagingConsent ?? 'opted_in',
    categories: buildConsentState({ user, records }),
  };
};

/**
 * Record a consent decision for one or more categories.
 *
 * Required categories are rejected rather than ignored: silently accepting an
 * opt-out that will never be honoured is how a customer ends up believing they
 * unsubscribed from something they will keep receiving.
 *
 * Every change writes an audit log entry, and unlike the fire-and-forget audit
 * in `updateUserConsent` the write is part of the same transaction — a consent
 * change with no trail is the one case where losing the log matters, because
 * the log *is* the proof of permission.
 */
const setCategoryConsent = async ({
  userId,
  categories,
  status,
  source = SOURCES.CUSTOMER_REQUEST,
  actorId = null,
  actorType = 'user',
  prisma = null,
}) => {
  const db = prisma || require('../common/prisma');
  const requested = Array.isArray(categories) ? categories : [categories];

  const unknown = requested.filter((category) => !isKnownCategory(category));
  if (unknown.length) {
    const error = new Error(`Unknown message consent categories: ${unknown.join(', ')}`);
    error.code = 'UNKNOWN_CONSENT_CATEGORY';
    throw error;
  }

  if (status !== STATUS.GRANTED && status !== STATUS.DENIED) {
    const error = new Error(`Invalid consent status: ${status}`);
    error.code = 'INVALID_CONSENT_STATUS';
    throw error;
  }

  const blocked = requested.filter((category) => isRequiredCategory(category) && status === STATUS.DENIED);
  if (blocked.length) {
    const error = new Error(`These categories cannot be switched off: ${blocked.join(', ')}`);
    error.code = 'REQUIRED_CONSENT_CATEGORY';
    throw error;
  }

  const now = new Date();
  const updated = [];

  for (const category of requested) {
    const record = await db.messagingConsentRecord.upsert({
      where: { userId_category: { userId, category } },
      create: { userId, category, status, source, updatedAt: now },
      update: { status, source, updatedAt: now },
    });
    updated.push(record);

    await db.auditLog.create({
      data: {
        actorType,
        actorId: actorId || userId,
        action: 'messaging_consent_category_updated',
        entityType: 'User',
        entityId: userId,
        metadata: { category, status, source, updatedAt: now.toISOString() },
      },
    });
  }

  return updated;
};

/**
 * Apply a STOP/START keyword across every optional category.
 *
 * The global flag is still written so anything reading it directly keeps
 * working; the per-category records are what the send path consults.
 */
const applyConsentKeyword = async ({ userId, phoneNumber, consent, source = SOURCES.WHATSAPP_KEYWORD, prisma = null }) => {
  const db = prisma || require('../common/prisma');
  const { categories, status, stillDelivered } = categoriesForKeyword(consent);

  const user = await updateUserConsent({ userId, phoneNumber, consent, source, prisma: db });
  await setCategoryConsent({ userId, categories, status, source, prisma: db });

  return { user, categories, status, stillDelivered };
};

module.exports = {
  parseConsentCommand,
  updateUserConsent,
  isMessageAllowed,
  checkMessagePermission,
  getConsentState,
  setCategoryConsent,
  applyConsentKeyword,
  normalizeCategory,
  LEGACY_CATEGORY_ALIASES,
  CATEGORIES,
  CATEGORY_NAMES,
  CONSENT_STATUS: STATUS,
  CONSENT_SOURCES: SOURCES,
  OPT_OUT_KEYWORDS,
  OPT_IN_KEYWORDS,
};
