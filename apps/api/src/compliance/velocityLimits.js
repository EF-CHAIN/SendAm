const { getRedisConnection } = require('../config/redis');
const config = require('../config/env');
const { getPolicyConversionSnapshot } = require('../pricing/policyRate');
const { getAssetRule, parseUnits } = require('../utils/money');

const TIER_LIMITS = Object.freeze({
  0: { dailyUsdCents: 5000, hourlyTransactions: 2 },
  1: { dailyUsdCents: 50000, hourlyTransactions: 5 },
  2: { dailyUsdCents: 500000, hourlyTransactions: null },
});

const RESERVE_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local dailyLimit = tonumber(ARGV[2])
local hourlyLimit = tonumber(ARGV[3])
local amountCents = tonumber(ARGV[4])
local member = ARGV[5]
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - 86400000)
if redis.call('ZSCORE', key, member) then return {1, 'ok'} end
if hourlyLimit > 0 and redis.call('ZCOUNT', key, now - 3600000, '+inf') >= hourlyLimit then
  return {0, 'hourly'}
end
local total = 0
local entries = redis.call('ZRANGEBYSCORE', key, now - 86400000, '+inf')
for _, entry in ipairs(entries) do
  local separator = string.find(entry, ':')
  if separator then total = total + tonumber(string.sub(entry, 1, separator - 1)) end
end
if total + amountCents > dailyLimit then return {0, 'daily'} end
redis.call('ZADD', key, now, member)
redis.call('EXPIRE', key, 90000)
return {1, 'ok'}
`;
const RELEASE_SCRIPT = `return redis.call('ZREM', KEYS[1], ARGV[1])`;

const toUsdCents = async ({ referenceAmount, referenceCurrency }) => {
  const currency = String(referenceCurrency || 'USD').toUpperCase();
  const currencyPrecision = getAssetRule(currency).precision;
  const amountUnits = parseUnits(String(referenceAmount), currencyPrecision, { rejectExcessPrecision: false });
  if (currency === 'USD') return Number(amountUnits);
  const usdRate = await getPolicyConversionSnapshot({ sourceAsset: 'USD', amount: '1' });
  const rate = String(usdRate.convertedAmount);
  const [whole, fraction = ''] = rate.split('.');
  const ratePrecision = fraction.length;
  const rateUnits = BigInt(`${whole}${fraction}`);
  const numerator = amountUnits * (10n ** BigInt(ratePrecision + 2));
  const denominator = rateUnits * (10n ** BigInt(currencyPrecision));
  const cents = (numerator + denominator - 1n) / denominator;
  return Number(cents);
};

const enforceVelocityLimit = async ({
  user,
  referenceAmount,
  referenceCurrency,
  reservationId,
  now = Date.now(),
  redis = getRedisConnection(config),
}) => {
  const tier = Math.max(0, Number(user.kycTier) || 0);
  const limits = TIER_LIMITS[Math.min(tier, 2)];
  const amountCents = await toUsdCents({ referenceAmount, referenceCurrency });
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw Object.assign(new Error('Unable to evaluate this payment against USD transaction limits.'), { statusCode: 503, code: 'VELOCITY_AMOUNT_UNAVAILABLE' });
  }
  if (!redis) {
    if (config.env === 'test') return { enforced: false, reason: 'redis_unconfigured_test' };
    throw Object.assign(new Error('Transaction velocity controls are unavailable; this payment cannot be authorized.'), { statusCode: 503, code: 'VELOCITY_LIMITS_UNAVAILABLE' });
  }
  const key = `sendam:velocity:${user.id}`;
  const member = `${amountCents}:${reservationId}`;
  let result;
  try {
    result = await redis.eval(
      RESERVE_SCRIPT,
      1,
      key,
      String(now),
      String(limits.dailyUsdCents),
      String(limits.hourlyTransactions || 0),
      String(amountCents),
      member,
    );
  } catch (error) {
    throw Object.assign(new Error('Transaction velocity controls are unavailable; this payment cannot be authorized.'), {
      statusCode: 503,
      code: 'VELOCITY_LIMITS_UNAVAILABLE',
      cause: error,
    });
  }
  if (Number(result?.[0]) === 1) return { enforced: true, amountCents, limits, key, member, redis };
  const reason = result?.[1];
  const message = reason === 'hourly'
    ? `Tier ${tier} allows ${limits.hourlyTransactions} transactions per hour. Upgrade your KYC tier to increase this limit.`
    : `Tier ${tier} has a $${(limits.dailyUsdCents / 100).toFixed(2)} rolling 24-hour limit. Upgrade your KYC tier to increase this limit.`;
  throw Object.assign(new Error(message), { statusCode: 429, code: 'VELOCITY_LIMIT_EXCEEDED', limit: reason });
};

const releaseVelocityReservation = async (reservation) => {
  if (!reservation?.enforced || !reservation.redis) return;
  await reservation.redis.eval(RELEASE_SCRIPT, 1, reservation.key, reservation.member);
};

module.exports = { TIER_LIMITS, toUsdCents, enforceVelocityLimit, releaseVelocityReservation };
