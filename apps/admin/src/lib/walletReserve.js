export const LOW_RESERVE_THRESHOLD_XLM = 20;
// Stellar base fee per transaction is 100 stroops (0.00001 XLM)
export const STELLAR_BASE_FEE_XLM = 0.00001;
const STROOPS_PER_XLM = 10_000_000;
const BASE_FEE_STROOPS = 100;

export function getWalletXlmBalance(wallet) {
  if (!wallet) return null;
  if (wallet.xlmBalance !== undefined && wallet.xlmBalance !== null) {
    const val = Number(wallet.xlmBalance);
    return isNaN(val) ? null : val;
  }
  if (wallet.balance !== undefined && wallet.balance !== null) {
    const val = Number(wallet.balance);
    return isNaN(val) ? null : val;
  }
  if (wallet.nativeBalance !== undefined && wallet.nativeBalance !== null) {
    const val = Number(wallet.nativeBalance);
    return isNaN(val) ? null : val;
  }
  if (Array.isArray(wallet.balances)) {
    const native = wallet.balances.find((b) => b.asset_type === 'native' || b.asset === 'XLM');
    if (native) {
      const val = Number(native.balance || native.amount || 0);
      return isNaN(val) ? null : val;
    }
  }
  return null;
}

export function calculateTxCapacity(xlmBalance) {
  if (xlmBalance === null || isNaN(xlmBalance)) return null;
  // Available above 1 XLM minimum base reserve. Done in integer stroops because
  // dividing XLM floats (e.g. 1 / 0.00001) lands just below the true integer.
  const spendableStroops = Math.max(0, Math.round((xlmBalance - 1) * STROOPS_PER_XLM));
  return Math.floor(spendableStroops / BASE_FEE_STROOPS);
}
