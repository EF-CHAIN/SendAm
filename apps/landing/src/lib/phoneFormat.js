/** Supported country presets with flag emoji, dial code, and national formatting.
 *  Spaces are inserted according to each country's standard national pattern.
 */
export const COUNTRY_PRESETS = [
  {
    code: 'NG',
    flag: '🇳🇬',
    name: 'Nigeria',
    dialCode: '+234',
    pattern: /^(\d{0,3})(\d{0,3})(\d{0,4})$/,
    format: (d) => [d.slice(0,3), d.slice(3,6), d.slice(6,10)].filter(Boolean).join(' '),
    regex: /^\+234\d{10}$/,
    placeholder: '+234 801 234 5678',
  },
  {
    code: 'GH',
    flag: '🇬🇭',
    name: 'Ghana',
    dialCode: '+233',
    format: (d) => [d.slice(0,2), d.slice(2,5), d.slice(5,9)].filter(Boolean).join(' '),
    regex: /^\+233\d{9}$/,
    placeholder: '+233 24 198 7654',
  },
  {
    code: 'KE',
    flag: '🇰🇪',
    name: 'Kenya',
    dialCode: '+254',
    format: (d) => [d.slice(0,3), d.slice(3,6), d.slice(6,9)].filter(Boolean).join(' '),
    regex: /^\+254\d{9}$/,
    placeholder: '+254 712 345 678',
  },
  {
    code: 'GB',
    flag: '🇬🇧',
    name: 'United Kingdom',
    dialCode: '+44',
    format: (d) => [d.slice(0,4), d.slice(4,7), d.slice(7,11)].filter(Boolean).join(' '),
    regex: /^\+44\d{10}$/,
    placeholder: '+44 7911 123 456',
  },
  {
    code: 'US',
    flag: '🇺🇸',
    name: 'United States',
    dialCode: '+1',
    format: (d) => [d.slice(0,3), d.slice(3,6), d.slice(6,10)].filter(Boolean).join(' '),
    regex: /^\+1\d{10}$/,
    placeholder: '+1 202 555 0123',
  },
];

/** Auto-format digits into national spacing pattern, prefixed with dial code. */
export function formatE164(rawDigits, country) {
  let digits = rawDigits.replace(/\D/g, '');
  const dialDigits = country.dialCode.replace(/\D/g, '');
  if (digits.startsWith(dialDigits)) {
    digits = digits.slice(dialDigits.length);
  }
  digits = digits.slice(0, 12);
  if (!digits) return country.dialCode;
  const formatted = country.format(digits);
  return `${country.dialCode} ${formatted}`;
}
