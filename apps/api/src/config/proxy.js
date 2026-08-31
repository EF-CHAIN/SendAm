const config = require('./env');

const normalizeTrustProxy = (rawValue) => {
  if (rawValue === undefined || rawValue === null || rawValue === '') return false;
  const value = String(rawValue).trim();
  if (!value || /^(?:off|false|0)$/i.test(value)) return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value.split(',').map((part) => part.trim()).filter(Boolean);
};

const getTrustProxySetting = () => {
  if (process.env.TRUST_PROXY !== undefined) {
    return normalizeTrustProxy(process.env.TRUST_PROXY);
  }

  const envName = process.env.NODE_ENV || config.env || 'development';
  if (envName === 'production') return 1;
  return false;
};

const isTrustedProxyHeader = (req) => {
  const trustSetting = req.app?.get?.('trust proxy');
  if (trustSetting === false || trustSetting === undefined || trustSetting === null) return false;
  return true;
};

const sanitizeForwardingHeaders = (req) => {
  if (!isTrustedProxyHeader(req) && req?.headers) {
    delete req.headers['x-forwarded-for'];
    delete req.headers['x-real-ip'];
    delete req.headers.forwarded;
  }
};

const getClientIp = (req) => {
  if (!req) return 'unknown';

  if (isTrustedProxyHeader(req)) {
    return req.ip || req.socket?.remoteAddress || 'unknown';
  }

  const forwardedFor = req.headers?.['x-forwarded-for'];
  if (forwardedFor && typeof forwardedFor === 'string') {
    const candidate = forwardedFor.split(',')[0].trim();
    if (candidate) return candidate;
  }

  return req.socket?.remoteAddress || req.ip || 'unknown';
};

module.exports = {
  normalizeTrustProxy,
  getTrustProxySetting,
  sanitizeForwardingHeaders,
  getClientIp,
};
