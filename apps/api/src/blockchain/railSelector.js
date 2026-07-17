const DOMESTIC_COUNTRIES = new Set(['NG']);

const normalizeCountry = (country) => (country || '').trim().toUpperCase();

const selectRail = ({ sourceCountry = 'NG', destinationCountry = 'NG', forceRail }) => {
  if (forceRail) return forceRail;

  const source = normalizeCountry(sourceCountry);
  const destination = normalizeCountry(destinationCountry);

  if (source && destination && source !== destination) {
    return 'stellar';
  }

  if (DOMESTIC_COUNTRIES.has(source || destination)) {
    return 'lisk';
  }

  return 'lisk';
};

module.exports = {
  selectRail,
};
