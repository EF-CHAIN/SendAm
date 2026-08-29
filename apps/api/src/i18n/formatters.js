const LOCALE_MAP = {
  en: 'en-US',
  fr: 'fr-FR',
  es: 'es-ES',
};

/**
 * Format date for localized customer output without altering timestamps.
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
  } catch (err) {
    return date.toISOString();
  }
};

/**
 * Format currency / amount for display presentation according to customer locale.
 * Underlying numeric strings and money calculations remain unchanged.
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
  } catch (err) {
    return `${amountStr} ${currencyOrAsset}`;
  }
};

module.exports = {
  formatDateByLocale,
  formatAmountByLocale,
  LOCALE_MAP,
};
