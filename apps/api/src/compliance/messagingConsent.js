// Message consent categories, statuses, and the rules that decide whether a
// given message may be sent (#310).
//
// Consent was previously a single `User.messagingConsent` flag: opted in or
// out of everything. That is too blunt in both directions — a customer who
// wants to stop marketing still needs the receipt for money they just sent,
// and a customer who never opted into marketing was treated as consenting
// because the column defaults to `opted_in`.
//
// This module splits consent by category and states the default per category,
// so the send path asks "is this category permitted for this user?" instead of
// "is this user opted in?".

/** Consent status for one category. */
const STATUS = {
  GRANTED: 'granted',
  DENIED: 'denied',
  /** No explicit choice recorded; the category default applies. */
  UNSET: 'unset',
};

/**
 * The categories a message can belong to.
 *
 * `required` marks a category that cannot be opted out of. Transactional and
 * security messages are the record of what happened to a customer's money and
 * the warning when their account is at risk; suppressing them would be a worse
 * outcome for the customer than any inbox relief it buys, and in the security
 * case it hides an attack.
 *
 * `defaultStatus` encodes the opposite asymmetry: service messages are on by
 * default because they are about something the customer initiated, marketing
 * is off by default because consent must be given, not assumed.
 */
const CATEGORIES = {
  transactional: {
    label: 'Transaction receipts and confirmations',
    required: true,
    defaultStatus: STATUS.GRANTED,
    description: 'Payment receipts, transfer confirmations, and failures.',
  },
  security: {
    label: 'Security and account alerts',
    required: true,
    defaultStatus: STATUS.GRANTED,
    description: 'PIN changes, new device sign-ins, suspicious activity.',
  },
  service: {
    label: 'Service updates',
    required: false,
    defaultStatus: STATUS.GRANTED,
    description: 'KYC outcomes, support replies, and status of a request you made.',
  },
  product: {
    label: 'Product announcements',
    required: false,
    defaultStatus: STATUS.DENIED,
    description: 'New features and changes to how SendAm works.',
  },
  marketing: {
    label: 'Offers and promotions',
    required: false,
    defaultStatus: STATUS.DENIED,
    description: 'Promotions, referral campaigns, and partner offers.',
  },
};

const CATEGORY_NAMES = Object.keys(CATEGORIES);

/** Categories a blanket STOP suppresses — everything not marked required. */
const OPTIONAL_CATEGORIES = CATEGORY_NAMES.filter((name) => !CATEGORIES[name].required);

/** Where a consent decision came from, for the audit trail. */
const SOURCES = {
  WHATSAPP_KEYWORD: 'whatsapp_keyword',
  CUSTOMER_REQUEST: 'customer_request',
  SUPPORT_AGENT: 'support_agent',
  ADMIN: 'admin',
  SYSTEM: 'system',
  IMPORT: 'import',
};

const isKnownCategory = (category) => Object.prototype.hasOwnProperty.call(CATEGORIES, category);
const isRequiredCategory = (category) => Boolean(CATEGORIES[category]?.required);
const defaultStatusFor = (category) => CATEGORIES[category]?.defaultStatus ?? STATUS.DENIED;

/**
 * Resolve the effective status of one category for a user.
 *
 * Precedence, strongest first:
 *  1. A required category is always granted — no stored record can revoke it.
 *  2. An explicit per-category record.
 *  3. The legacy global `User.messagingConsent = 'opted_out'`, which is read
 *     as denying every optional category. Existing opt-outs must keep working
 *     unchanged; a customer who sent STOP before this change did not consent
 *     to start receiving marketing again because the schema grew.
 *  4. The category default.
 */
const resolveCategoryStatus = ({ category, user = null, records = [] }) => {
  if (!isKnownCategory(category)) return STATUS.DENIED;
  if (isRequiredCategory(category)) return STATUS.GRANTED;

  const record = records.find((entry) => entry.category === category);
  if (record && record.status !== STATUS.UNSET) return record.status;

  if (user && user.messagingConsent === 'opted_out') return STATUS.DENIED;
  if (user && user.messagingConsent === 'opted_in') return STATUS.GRANTED;

  return defaultStatusFor(category);
};

/**
 * The full consent picture for a user — what support sees, and what an export
 * contains. Every category is listed, including ones never explicitly set, so
 * a support agent can tell "denied" apart from "never asked".
 */
const buildConsentState = ({ user = null, records = [] }) =>
  CATEGORY_NAMES.map((category) => {
    const record = records.find((entry) => entry.category === category) || null;
    return {
      category,
      label: CATEGORIES[category].label,
      description: CATEGORIES[category].description,
      required: CATEGORIES[category].required,
      status: resolveCategoryStatus({ category, user, records }),
      explicit: Boolean(record && record.status !== STATUS.UNSET),
      source: record?.source ?? null,
      updatedAt: record?.updatedAt ?? null,
    };
  });

/**
 * Whether a message in `category` may be sent to `user`.
 *
 * An unknown category is refused rather than allowed. A typo in a send call
 * should stop that message, not quietly bypass consent for every customer.
 */
const isMessagePermitted = ({ category, user = null, records = [] }) => {
  if (!isKnownCategory(category)) {
    return { permitted: false, reason: 'unknown_category', category };
  }
  const status = resolveCategoryStatus({ category, user, records });
  return {
    permitted: status === STATUS.GRANTED,
    reason: status === STATUS.GRANTED ? 'granted' : 'denied',
    category,
    required: isRequiredCategory(category),
  };
};

/**
 * Categories a consent keyword affects.
 *
 * STOP suppresses every optional category rather than only marketing: a
 * customer who says stop means stop, and leaving service messages running
 * because they are "useful" is exactly the behaviour that erodes trust in the
 * keyword. Required categories are unaffected and the caller is told so, so
 * the confirmation can say what will still arrive.
 */
const categoriesForKeyword = (consent) => ({
  categories: OPTIONAL_CATEGORIES,
  status: consent === 'opted_out' ? STATUS.DENIED : STATUS.GRANTED,
  stillDelivered: CATEGORY_NAMES.filter(isRequiredCategory),
});

module.exports = {
  STATUS,
  CATEGORIES,
  CATEGORY_NAMES,
  OPTIONAL_CATEGORIES,
  SOURCES,
  isKnownCategory,
  isRequiredCategory,
  defaultStatusFor,
  resolveCategoryStatus,
  buildConsentState,
  isMessagePermitted,
  categoriesForKeyword,
};
