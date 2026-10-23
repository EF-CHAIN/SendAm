const MASK = '•';
const MASK_GROUP = MASK.repeat(3);
const COUNTRY_CODE_DIGITS = 3;
const VISIBLE_SUFFIX_DIGITS = 4;
// Below this many digits, even the last four would reveal too much of the number.
const MIN_DIGITS_FOR_PARTIAL_MASK = 8;

/**
 * Masks the middle digits of a phone number for display.
 *
 *   maskPhoneNumber('+2348012344219')       -> '+234 ••• ••• 4219'
 *   maskPhoneNumber('08012344219')          -> '••• ••• 4219'
 *   maskPhoneNumber('+2348012344219', true) -> '+2348012344219'
 *
 * The number is masked unless `isRevealed` is truthy. Numbers too short to
 * show a suffix safely are fully masked, and empty input returns ''.
 */
export const maskPhoneNumber = (phone, isRevealed = false) => {
  if (!phone) return '';
  const value = String(phone).trim();
  if (isRevealed) return value;

  const digits = value.replace(/\D/g, '');
  if (digits.length < MIN_DIGITS_FOR_PARTIAL_MASK) return MASK_GROUP;

  const countryCode = value.startsWith('+') ? `+${digits.slice(0, COUNTRY_CODE_DIGITS)} ` : '';
  return `${countryCode}${MASK_GROUP} ${MASK_GROUP} ${digits.slice(-VISIBLE_SUFFIX_DIGITS)}`;
};
