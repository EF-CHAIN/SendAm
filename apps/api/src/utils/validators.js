const { parsePhoneNumberWithError } = require('libphonenumber-js');

const DEFAULT_REGION = process.env.DEFAULT_PHONE_REGION || 'NG';

const canonicalizePhoneNumber = (phone, defaultRegion = DEFAULT_REGION) => {
  if (typeof phone !== 'string' || !phone.trim()) {
    throw new Error('Invalid phone number: Must be a non-empty string');
  }

  const raw = phone.trim();

  // Try parsing raw directly first
  try {
    const parsed = parsePhoneNumberWithError(raw, defaultRegion);
    if (parsed && parsed.isValid()) {
      return parsed.number;
    }
  } catch (_err) {
    // Fall through to retry with leading + if missing
  }

  // If missing leading + (e.g. "2348000000001"), retry with leading +
  if (!raw.startsWith('+')) {
    try {
      const parsed = parsePhoneNumberWithError(`+${raw}`, defaultRegion);
      if (parsed && parsed.isValid()) {
        return parsed.number;
      }
    } catch (_err) {
      // Fall through
    }
  }

  throw new Error(`Invalid or unsupported phone number: "${phone}"`);
};

const isValidPhoneNumber = (phone, defaultRegion = DEFAULT_REGION) => {
  try {
    canonicalizePhoneNumber(phone, defaultRegion);
    return true;
  } catch {
    return false;
  }
};

const { assertValidAmount } = require('./money');

const isValidAmount = (amount, asset = 'XLM') => {
  try {
    assertValidAmount(amount, asset);
    return true;
  } catch (_error) {
    return false;
  }
};

module.exports = {
  canonicalizePhoneNumber,
  isValidPhoneNumber,
  isValidAmount,
};

