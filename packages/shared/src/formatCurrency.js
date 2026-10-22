const fiatCurrencies = new Set(Intl.supportedValuesOf('currency'));

/**
 * Format a display amount in en-US, without changing transaction arithmetic.
 * ISO currencies use their Intl minor units (USD/EUR/NGN/GBP: exactly 2).
 * Other Stellar asset codes use 0–7 decimals followed by the asset code.
 * Pass a decimal string to avoid losing precision through JS number conversion.
 * @param {number|string} amount Finite number or plain signed decimal string.
 * @param {string} currencyCode ISO currency or 1–12 alphanumeric asset code.
 * @returns {string}
 * @throws {TypeError} If the amount or currency code is invalid.
 */
export const formatCurrency = (amount, currencyCode) => {
  const isNumber = typeof amount === 'number';
  const isDecimal = typeof amount === 'string' && /^[+-]?\d+(?:\.\d+)?$/.test(amount.trim());
  if ((!isNumber && !isDecimal) || !Number.isFinite(Number(amount))) {
    throw new TypeError('Amount must be a finite number or decimal string.');
  }
  if (typeof currencyCode !== 'string' || !/^[a-z0-9]{1,12}$/i.test(currencyCode.trim())) {
    throw new TypeError('Currency code must contain 1–12 letters or digits.');
  }

  const assetCode = currencyCode.trim();
  const code = assetCode.toUpperCase();
  // Keep strings as strings: Number(amount) would lose Stellar precision on
  // large balances. signDisplay also suppresses the sign on rounded zero.
  const value = isNumber ? amount : amount.trim();
  if (fiatCurrencies.has(code)) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code,
      currencyDisplay: code === 'NGN' ? 'narrowSymbol' : 'symbol',
      signDisplay: 'negative',
    }).format(value);
  }

  // Intl currency style accepts only three-letter codes; USDC and custom
  // Stellar assets must be formatted as numbers with a separate code suffix.
  const formatted = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 7,
    signDisplay: 'negative',
  }).format(value);
  // Stellar asset codes are case-sensitive: Token and TOKEN are distinct.
  return `${formatted} ${assetCode}`;
};
