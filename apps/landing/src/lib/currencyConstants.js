// Indicative rates for African remittance corridors
export const EXCHANGE_RATES = {
  USD: {
    NGN: 1550,
    KES: 129,
    GHS: 15.5,
  },
  EUR: {
    NGN: 1680,
    KES: 140,
    GHS: 16.8,
  },
  GBP: {
    NGN: 1980,
    KES: 165,
    GHS: 19.8,
  },
};

export const SOURCE_CURRENCIES = [
  { code: 'USD', symbol: '$', label: 'US Dollar', flag: '🇺🇸' },
  { code: 'EUR', symbol: '€', label: 'Euro', flag: '🇪🇺' },
  { code: 'GBP', symbol: '£', label: 'British Pound', flag: '🇬🇧' },
];

export const TARGET_CURRENCIES = [
  { code: 'NGN', symbol: '₦', label: 'Nigerian Naira', flag: '🇳🇬', country: 'Nigeria' },
  { code: 'KES', symbol: 'KSh', label: 'Kenyan Shilling', flag: '🇰🇪', country: 'Kenya' },
  { code: 'GHS', symbol: 'GH₵', label: 'Ghanaian Cedi', flag: '🇬🇭', country: 'Ghana' },
];

export const PRESET_AMOUNTS = [50, 100, 250, 500];

// Resolves the indicative rate between any two known currencies. Rates are
// stored only for the send corridors, so the reverse direction falls back to
// the reciprocal of the stored rate. Unknown pairs fall back to 1.
export function getExchangeRate(from, to) {
  if (!from || !to || from === to) return 1;
  const direct = EXCHANGE_RATES[from]?.[to];
  if (direct) return direct;
  const reverse = EXCHANGE_RATES[to]?.[from];
  if (reverse) return 1 / reverse;
  return 1;
}
