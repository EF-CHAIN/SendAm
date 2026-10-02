/**
 * Map of supported ISO 639-1 language codes to BCP 47 locale identifiers.
 *
 * @type {Record<string, string>}
 */
const LOCALE_MAP = {
  en: 'en-US',
  fr: 'fr-FR',
  es: 'es-ES',
};

/**
 * Formats a Date object or date input string/timestamp according to customer locale.
 *
 * Uses Intl.DateTimeFormat with a fallback to ISO string on formatting errors.
 *
 * @param {Date|string|number} dateInput - The Date instance, ISO string, or timestamp to format.
 * @param {string} [locale='en'] - The ISO language code ('en', 'fr', 'es').
 * @param {Intl.DateTimeFormatOptions} [options={}] - Custom formatting options overriding defaults.
 * @returns {string} The localized date-time string.
 *
 * @example
 * formatDateByLocale(new Date('2026-08-26T12:00:00Z'), 'en');
 * // returns "Aug 26, 2026, 12:00 PM"
 *
 * @example
 * formatDateByLocale('2026-08-26T12:00:00Z', 'fr');
 * // returns "26 août 2026, 12:00"
 */
const formatDateByLocale = (dateInput, locale = 'en', options = {}) => {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (Number.isNaN(date.getTime())) return String(dateInput);

  const targetLocale = LOCALE_MAP[locale] || 'en-US';
  const defaultOptions = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    ...options,
  };

  try {
    return new Intl.DateTimeFormat(targetLocale, defaultOptions).format(date);
  } catch (_err) {
    return date.toISOString();
  }
};

/**
 * Formats a currency amount or crypto asset string for localized display.
 *
 * Formats recognized fiat currencies (USD, EUR, GBP, NGN) using standard Intl currency style,
 * and crypto assets (XLM, USDC) preserving precision without altering underlying numeric values.
 *
 * @param {string|number} amountStr - The numeric amount as string or number.
 * @param {string} [currencyOrAsset='USDC'] - Currency or asset code (e.g. 'USD', 'NGN', 'EUR', 'GBP', 'USDC', 'XLM').
 * @param {string} [locale='en'] - The ISO language code ('en', 'fr', 'es').
 * @returns {string} The formatted localized amount string.
 *
 * @example
 * formatAmountByLocale('1000.50', 'USD', 'en');
 * // returns "$1,000.50"
 *
 * @example
 * formatAmountByLocale('1000.50', 'USDC', 'en');
 * // returns "1,000.50 USDC"
 *
 * @example
 * formatAmountByLocale('500', 'XLM', 'es');
 * // returns "500 XLM"
 */
const formatAmountByLocale = (amountStr, currencyOrAsset = 'USDC', locale = 'en') => {
  const num = Number(amountStr);
  if (Number.isNaN(num)) return `${amountStr} ${currencyOrAsset}`;

  const targetLocale = LOCALE_MAP[locale] || 'en-US';
  const symbolMap = {
    NGN: '₦',
    USD: '$',
    EUR: '€',
    GBP: '£',
  };

  try {
    // If it's a recognized ISO fiat currency, format with Intl.NumberFormat
    if (['USD', 'EUR', 'GBP', 'NGN'].includes(currencyOrAsset.toUpperCase())) {
      return new Intl.NumberFormat(targetLocale, {
        style: 'currency',
        currency: currencyOrAsset.toUpperCase(),
        minimumFractionDigits: 2,
        maximumFractionDigits: 4,
      }).format(num);
    }

    // For XLM, USDC or custom crypto assets, preserve precision
    const decimals = amountStr.includes('.') ? amountStr.split('.')[1].length : 0;
    const formattedNum = new Intl.NumberFormat(targetLocale, {
      minimumFractionDigits: decimals > 0 ? Math.min(decimals, 2) : 0,
      maximumFractionDigits: 7,
    }).format(num);

    const sym = symbolMap[currencyOrAsset.toUpperCase()];
    if (sym) {
      return `${sym}${formattedNum}`;
    }
    return `${formattedNum} ${currencyOrAsset.toUpperCase()}`;
  } catch (_err) {
    return `${amountStr} ${currencyOrAsset}`;
  }
};

module.exports = {
  formatDateByLocale,
  formatAmountByLocale,
  LOCALE_MAP,
};
