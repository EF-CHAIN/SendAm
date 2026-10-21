const { parsePhoneNumberWithError } = require('libphonenumber-js');
const { assertValidAmount } = require('./money');

const DEFAULT_REGION = process.env.DEFAULT_PHONE_REGION || 'NG';

/**
 * Canonicalizes a phone number into standard E.164 international format.
 *
 * Trims whitespace and attempts parsing using libphonenumber-js with the specified default region.
 * Automatically retries with a leading '+' if country code is present without a plus sign.
 *
 * @param {string} phone - The input phone number string to canonicalize.
 * @param {string} [defaultRegion='NG'] - The default two-letter ISO country code (e.g. 'NG', 'US').
 * @returns {string} The canonical E.164 formatted phone number (e.g. '+2348000000001').
 * @throws {Error} If phone is not a non-empty string or cannot be parsed as a valid phone number.
 *
 * @example
 * // Valid input examples:
 * canonicalizePhoneNumber('+2348000000001'); // returns '+2348000000001'
 * canonicalizePhoneNumber('08000000001');     // returns '+2348000000001'
 * canonicalizePhoneNumber('2348000000001');   // returns '+2348000000001'
 * canonicalizePhoneNumber('+1 202-555-0123'); // returns '+12025550123'
 *
 * @example
 * // Invalid input examples (throws Error):
 * canonicalizePhoneNumber('123');           // throws Error: Invalid or unsupported phone number: "123"
 * canonicalizePhoneNumber('not-a-phone');   // throws Error: Invalid or unsupported phone number: "not-a-phone"
 * canonicalizePhoneNumber('');              // throws Error: Invalid phone number: Must be a non-empty string
 * canonicalizePhoneNumber(null);            // throws Error: Invalid phone number: Must be a non-empty string
 */
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

/**
 * Checks whether a given phone number is valid and can be canonicalized.
 *
 * Safely calls `canonicalizePhoneNumber` and returns a boolean without throwing errors.
 *
 * @param {string} phone - The phone number string to validate.
 * @param {string} [defaultRegion='NG'] - The default two-letter ISO country code (e.g. 'NG', 'US').
 * @returns {boolean} True if the phone number is valid, false otherwise.
 *
 * @example
 * // Valid input examples (returns true):
 * isValidPhoneNumber('+2348000000001'); // true
 * isValidPhoneNumber('08000000001');     // true
 * isValidPhoneNumber('2348000000001');   // true
 * isValidPhoneNumber('+12025550123');   // true
 *
 * @example
 * // Invalid input examples (returns false):
 * isValidPhoneNumber('123');       // false
 * isValidPhoneNumber('abc');       // false
 * isValidPhoneNumber('');          // false
 * isValidPhoneNumber(null);        // false
 * isValidPhoneNumber(undefined);   // false
 */
const isValidPhoneNumber = (phone, defaultRegion = DEFAULT_REGION) => {
  try {
    canonicalizePhoneNumber(phone, defaultRegion);
    return true;
  } catch {
    return false;
  }
};

/**
 * Checks whether an amount is valid for the specified currency/asset.
 *
 * Validates that the amount is a positive number/numeric string within the allowed
 * min and max limits and decimal precision defined for the asset.
 *
 * @param {string|number} amount - The amount value to validate.
 * @param {string} [asset='XLM'] - The asset code (e.g. 'XLM', 'USDC', 'NGN', 'USD', 'EUR', 'GBP').
 * @returns {boolean} True if the amount is valid for the asset, false otherwise.
 *
 * @example
 * // Valid input examples (returns true):
 * isValidAmount(100);             // true
 * isValidAmount('50.25', 'NGN');  // true
 * isValidAmount('0.0000001');     // true (valid for default XLM precision)
 *
 * @example
 * // Invalid input examples (returns false):
 * isValidAmount(0);       // false (must be > 0)
 * isValidAmount(-10);     // false (must be positive)
 * isValidAmount('abc');   // false (non-numeric string)
 * isValidAmount(null);    // false
 */
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
