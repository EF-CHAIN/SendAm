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
