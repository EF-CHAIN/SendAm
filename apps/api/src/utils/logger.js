const { getContext } = require('../observability/context');

const { redactString: sanitizeString, redactionForKey } = require('../middlewares/redactPii');

const sanitize = (value, seen = new WeakSet()) => {
  if (typeof value === 'string') return sanitizeString(value);
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeString(value.message || ''),
      stack: value.stack ? sanitizeString(value.stack) : undefined,
    };
  }
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (Array.isArray(value)) return value.map((item) => sanitize(item, seen));
  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const output = {};
    for (const [key, nested] of Object.entries(value)) {
      output[key] = redactionForKey(key) ?? sanitize(nested, seen);
    }
    return output;
  }
  return String(value);
};

const normalizeArgs = (args) => {
  const [first, ...rest] = args;
  const record = {};
  if (typeof first === 'string') {
    record.message = sanitizeString(first);
  } else if (first !== undefined) {
    record.data = sanitize(first);
  }
  if (rest.length === 1 && rest[0] instanceof Error) record.error = sanitize(rest[0]);
  else if (rest.length === 1 && typeof rest[0] === 'object') record.data = sanitize(rest[0]);
  else if (rest.length) record.details = sanitize(rest);
  return record;
};

const write = (level, args) => {
  if (level === 'debug' && process.env.NODE_ENV === 'production') return;
  const record = {
    timestamp: new Date().toISOString(),
    level,
    service: process.env.SERVICE_NAME || 'sendam-api',
    environment: process.env.NODE_ENV || 'development',
    ...sanitize(getContext()),
    ...normalizeArgs(args),
  };
  const line = JSON.stringify(record);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

const logger = {
  info: (...args) => write('info', args),
  error: (...args) => write('error', args),
  warn: (...args) => write('warn', args),
  debug: (...args) => write('debug', args),
  child: (fields) => ({
    info: (...args) => write('info', [args[0], { ...fields, ...(args[1] || {}) }]),
    error: (...args) => write('error', [args[0], { ...fields, ...(args[1] || {}) }]),
    warn: (...args) => write('warn', [args[0], { ...fields, ...(args[1] || {}) }]),
    debug: (...args) => write('debug', [args[0], { ...fields, ...(args[1] || {}) }]),
  }),
  sanitize,
};

module.exports = logger;
