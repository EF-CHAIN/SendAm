const { formatUnits, parseUnits } = require('../utils/money');

const PRECISION = 7;

const nativeBalance = (account, { feeStroops, baseReserveStroops, additionalSubentries = 0, buffer = '0' }) => {
  const native = account.balances.find((balance) => balance.asset_type === 'native');
  const total = parseUnits(native?.balance ?? '0', PRECISION);
  const entries = 2 + (account.subentry_count ?? 0) + (account.num_sponsoring ?? 0)
    - (account.num_sponsored ?? 0) + additionalSubentries;
  const required = BigInt(entries) * BigInt(baseReserveStroops) + BigInt(feeStroops)
    + parseUnits(native?.selling_liabilities ?? '0', PRECISION) + parseUnits(buffer, PRECISION);
  const available = total - required;
  return { total, required, available, spendable: formatUnits(available > 0n ? available : 0n, PRECISION) };
};

module.exports = { nativeBalance, PRECISION };
