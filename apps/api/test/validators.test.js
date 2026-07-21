/**
 * Validates if a phone number is plausible
 * Accepts international formats with common separators
 */
const isValidPhoneNumber = (phone) => {
  if (typeof phone !== 'string' || !phone) {
    return false;
  }

  // Remove common formatting characters: spaces, dashes, parentheses, dots, extensions
  const cleaned = phone
    .replace(/[\s\-\(\)\.\,xXextEXT]+/g, '')
    .trim();

  // Must have at least 6 digits after cleaning
  return cleaned.length >= 6 && /^[0-9+]+$/.test(cleaned);
};

/**
 * Validates if an amount is a positive finite number
 * Accepts numbers and numeric strings
 */
const isValidAmount = (amount) => {
  // Reject null, undefined
  if (amount == null) return false;

  // Handle booleans
  if (typeof amount === 'boolean') return amount;

  // Reject arrays and objects explicitly
  if (Array.isArray(amount) || (typeof amount === 'object' && amount !== null)) {
    return false;
  }

  // Convert to number safely
  const num = Number(amount);

  // Must be finite and strictly greater than 0
  return Number.isFinite(num) && num > 0;
};

module.exports = {
  isValidPhoneNumber,
  isValidAmount,
};