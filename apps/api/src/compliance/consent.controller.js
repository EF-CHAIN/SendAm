// Consent read/write endpoints for customers and support (#310).

const {
  getConsentState,
  setCategoryConsent,
  CONSENT_STATUS,
  CONSENT_SOURCES,
} = require('./consent.service');
const logger = require('../utils/logger');

/** Customer reads their own preferences. */
const getOwnPreferences = async (req, res, next) => {
  try {
    res.json(await getConsentState({ userId: req.user.id }));
  } catch (error) {
    next(error);
  }
};

/**
 * Customer updates their own preferences.
 *
 * A rejected category (unknown, or one that cannot be switched off) returns
 * 400 with the reason rather than partially applying the request — a
 * half-applied preference change is worse than a rejected one, because the
 * customer has no way to tell which half took effect.
 */
const updateOwnPreferences = async (req, res, next) => {
  const { categories, status } = req.body || {};
  try {
    const updated = await setCategoryConsent({
      userId: req.user.id,
      categories,
      status,
      source: CONSENT_SOURCES.CUSTOMER_REQUEST,
      actorType: 'user',
      actorId: req.user.id,
    });
    logger.info('messaging_consent_updated', {
      userId: req.user.id,
      categories: updated.map((record) => record.category),
      status,
    });
    res.json(await getConsentState({ userId: req.user.id }));
  } catch (error) {
    if (
      error.code === 'UNKNOWN_CONSENT_CATEGORY' ||
      error.code === 'INVALID_CONSENT_STATUS' ||
      error.code === 'REQUIRED_CONSENT_CATEGORY'
    ) {
      return res.status(400).json({ error: error.message, code: error.code });
    }
    return next(error);
  }
};

/**
 * Support reads a customer's consent state.
 *
 * Support can read but not write: a preference changed by an agent with no
 * request from the customer is indistinguishable, after the fact, from one the
 * customer made. Anything an agent must change goes through the keyword or
 * self-service paths so the source is honest.
 */
const getCustomerPreferences = async (req, res, next) => {
  try {
    res.json(await getConsentState({ userId: req.params.userId }));
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getOwnPreferences,
  updateOwnPreferences,
  getCustomerPreferences,
  CONSENT_STATUS,
};
