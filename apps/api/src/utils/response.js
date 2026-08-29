const { getContext } = require('../observability/context');
const { errorEnvelope } = require('../errors/envelope');

// Correlation ID travels on every response — both as the `x-correlation-id`
// header (set by correlationMiddleware) and inside the JSON body so clients can
// match a failure to server logs without reading headers.
const correlationIdOf = () => getContext().correlationId || null;

const withCorrelation = (body) => ({ ...body, correlationId: correlationIdOf() });

const sendSuccess = (res, data, message = 'Success', statusCode = 200) => {
  res.status(statusCode).json(withCorrelation({
    success: true,
    message,
    data,
  }));
};

const sendError = (res, message = 'Error', statusCode = 400, details) => {
  const error = new Error(message);
  if (statusCode) error.statusCode = statusCode;
  if (details !== undefined) error.details = details;
  res.status(statusCode).json(errorEnvelope(error, { correlationId: correlationIdOf() }));
};

// Paginated list response. `data` stays a plain array so existing clients keep
// working, with a `pagination` block alongside for page controls.
const sendPaginated = (res, items, { page, limit, total }, message = 'Success') => {
  res.status(200).json(withCorrelation({
    success: true,
    message,
    data: items,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  }));
};

// Cursor (keyset) paginated list response. `nextCursor`/`prevCursor` are opaque
// tokens; `hasMore` reflects whether another forward page exists. `total` is
// optional (a filtered count) and omitted when not computed.
const sendCursorPaginated = (
  res,
  items,
  { limit, nextCursor = null, prevCursor = null, total = null, hasMore = Boolean(nextCursor) },
  message = 'Success'
) => {
  const pagination = { limit, nextCursor, prevCursor, hasMore };
  if (total !== null && total !== undefined) pagination.total = total;
  res.status(200).json(withCorrelation({ success: true, message, data: items, pagination }));
};

module.exports = {
  sendSuccess,
  sendError,
  sendPaginated,
  sendCursorPaginated,
};
