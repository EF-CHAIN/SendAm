// Normalize any thrown value into a stable `{ code, statusCode, message, safe }`
// result backed by the catalog. This is the single seam where validation, auth,
// conflict, rate-limit, provider, and internal failures are mapped to their
// stable codes and HTTP statuses.
const { CATALOG, keyForStatusCode } = require('./catalog');
const { AppError } = require('./AppError');

// Prisma exposes stable error codes. Unique/FK violations are conflicts; a
// missing record is a not-found; constraint/type violations are validation
// problems. Everything else from Prisma is internal.
const PRISMA_CONFLICT_CODES = new Set(['P2002', 'P2003', 'P2014']);
const PRISMA_NOT_FOUND_CODES = new Set(['P2001', 'P2025']);
const PRISMA_VALIDATION_CODES = new Set([
  'P2000', 'P2004', 'P2005', 'P2006', 'P2007', 'P2008', 'P2009', 'P2010',
  'P2011', 'P2012', 'P2013', 'P2015', 'P2016', 'P2023',
]);

// Axios and the Stellar/WhatsApp/Deepgram SDKs fail through request errors.
// Those are all upstream provider failures from the client's perspective.
const isProviderRequestError = (error) => (
  error && (error.isAxiosError === true || Boolean(error.response) || Boolean(error.config))
);

const isRateLimitError = (error) => (
  error
  && (error.statusCode === 429
    || error.name === 'RateLimitError'
    || error.code === 'ERR_ERL_LIMIT'
    || error.code === 'RATE_LIMIT_EXCEEDED')
);

const isBodyParserError = (error) => (
  error && (error.type === 'entity.parse.failed' || error.type === 'entity.too.large')
);

const isPrismaError = (error) => typeof error?.code === 'string' && /^P\d{4}$/.test(error.code);

// Build the normalized result. When an entry is not client-safe, the real
// message is replaced with the catalog's generic message so secrets, stack
// traces, and provider internals never reach a response body.
const toResult = (entryKey, error, overrides = {}) => {
  const entry = CATALOG[entryKey];
  const safe = overrides.safe !== undefined ? overrides.safe : entry.safe;
  const message = safe
    ? (overrides.message ?? error?.message ?? entry.defaultMessage)
    : entry.defaultMessage;
  return {
    code: entry.code,
    statusCode: overrides.statusCode || entry.statusCode,
    message,
    safe,
    details: overrides.details !== undefined ? overrides.details : error?.details,
  };
};

const normalizeError = (error) => {
  if (error instanceof AppError) {
    const entry = CATALOG[error.code] || CATALOG.INTERNAL;
    const safe = error.safe !== undefined ? error.safe : entry.safe;
    return {
      code: error.code,
      statusCode: error.statusCode,
      message: safe ? error.message : entry.defaultMessage,
      safe,
      details: error.details,
    };
  }

  if (isPrismaError(error)) {
    if (PRISMA_CONFLICT_CODES.has(error.code)) {
      return toResult('CONFLICT', error, { message: 'The request conflicts with an existing record.' });
    }
    if (PRISMA_NOT_FOUND_CODES.has(error.code)) {
      return toResult('NOT_FOUND', error, { message: 'The requested record was not found.' });
    }
    if (PRISMA_VALIDATION_CODES.has(error.code)) {
      return toResult('VALIDATION', error);
    }
    return toResult('INTERNAL', error, { safe: false });
  }

  if (isRateLimitError(error)) {
    return toResult('RATE_LIMITED', error);
  }

  if (isBodyParserError(error)) {
    return toResult('VALIDATION', error);
  }

  // Bare errors that already carry an HTTP status (not-found, admin auth,
  // "not configured" service errors, cursor pagination, etc.) map by status.
  if (Number.isInteger(error?.statusCode)) {
    return toResult(keyForStatusCode(error.statusCode), error, { statusCode: error.statusCode });
  }

  if (isProviderRequestError(error)) {
    return toResult('PROVIDER', error);
  }

  return toResult('INTERNAL', error, { safe: false });
};

module.exports = { normalizeError };
