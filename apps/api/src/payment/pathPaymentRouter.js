const { StellarSdk } = require('../config/stellar');
const { formatUnits, parseUnits } = require('../utils/money');

const PRECISION = 7;
const MAX_STROOPS = (1n << 63n) - 1n;

const pathAmount = (value) => {
  let units;
  try {
    units = parseUnits(value, PRECISION);
  } catch {
    throw Object.assign(new Error('Path amounts must be decimal strings with up to seven places.'), { statusCode: 400 });
  }
  if (units <= 0n || units > MAX_STROOPS) {
    throw Object.assign(new Error('Path amount is outside the Stellar amount range.'), { statusCode: 400 });
  }
  return units;
};

const horizonAsset = (type, code, issuer) => {
  if (type === 'native') return StellarSdk.Asset.native();
  if (type === 'credit_alphanum4' || type === 'credit_alphanum12') return new StellarSdk.Asset(code, issuer);
  throw new Error('Unexpected Horizon asset type');
};

const readPaths = ({ records }, source, target) => records.flatMap((record) => {
  try {
    const from = horizonAsset(record.source_asset_type, record.source_asset_code, record.source_asset_issuer);
    const to = horizonAsset(record.destination_asset_type, record.destination_asset_code, record.destination_asset_issuer);
    if (!from.equals(source) || !to.equals(target) || record.path.length > 5) return [];
    const path = record.path.map(({ asset_type, asset_code, asset_issuer }) => horizonAsset(asset_type, asset_code, asset_issuer));
    const key = path.map(String).join(',');
    if (path.some((hop) => hop.equals(source) || hop.equals(target)) || new Set(path.map(String)).size !== path.length) return [];
    return [{ path, key, source: pathAmount(record.source_amount), target: pathAmount(record.destination_amount) }];
  } catch {
    return [];
  }
});

const routePathPayment = async ({ server, source, target, maxSource, destination, destinationAmount }) => {
  const budget = pathAmount(maxSource);
  const receive = pathAmount(destinationAmount);
  const [receivePaths, sendPaths] = await Promise.all([
    server.strictReceivePaths([source], target, destinationAmount).call(),
    server.strictSendPaths(source, maxSource, [target]).call(),
  ]);

  const outputAtBudget = new Map();
  for (const quote of readPaths(sendPaths, source, target)) {
    if (quote.source === budget && quote.target > (outputAtBudget.get(quote.key) ?? 0n)) {
      outputAtBudget.set(quote.key, quote.target);
    }
  }

  // Horizon amounts include conversion costs. Every candidate is one operation
  // and has the same network fee, regardless of its number of hops.
  const candidates = readPaths(receivePaths, source, target)
    .filter((quote) => quote.target === receive && quote.source <= budget)
    .sort((a, b) => {
      if (a.source !== b.source) return a.source < b.source ? -1 : 1;
      const left = outputAtBudget.get(a.key) ?? 0n;
      const right = outputAtBudget.get(b.key) ?? 0n;
      if (left !== right) return left > right ? -1 : 1;
      return a.path.length - b.path.length;
    });
  const best = candidates[0];
  if (!best) {
    throw Object.assign(new Error('No Stellar payment path can deliver the requested amount within the source limit.'), { statusCode: 409 });
  }

  const slippageCap = best.source + best.source * 50n / 10_000n;
  return StellarSdk.Operation.pathPaymentStrictReceive({
    sendAsset: source,
    sendMax: formatUnits(slippageCap < budget ? slippageCap : budget, PRECISION),
    destination,
    destAsset: target,
    destAmount: destinationAmount,
    path: best.path,
  });
};

// A single strict-receive operation records its fills in the transaction result.
// Paths with a repeated endpoint are excluded above, so only the source leg
// can buy the source asset.
const readSourceDebit = (resultXdr, source) => {
  const result = StellarSdk.xdr.TransactionResult.fromXDR(resultXdr, 'base64').result();
  const [operation] = result.results();
  const fills = operation.tr().pathPaymentStrictReceiveResult().success().offers();
  const debit = fills.reduce((sum, fill) => {
    const claim = fill.value();
    return StellarSdk.Asset.fromOperation(claim.assetBought()).equals(source)
      ? sum + BigInt(claim.amountBought().toString()) : sum;
  }, 0n);
  if (debit <= 0n) throw new Error('Missing source debit in Stellar path payment result.');
  return formatUnits(debit, PRECISION);
};

module.exports = { routePathPayment, pathAmount, readSourceDebit };
