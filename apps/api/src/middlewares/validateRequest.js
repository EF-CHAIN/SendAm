const stripSecrets = (value) => {
  if (typeof value !== 'string') return value;
  return value.length > 6 ? `${value.slice(0, 2)}***${value.slice(-2)}` : '***';
};

const normalizeError = (path, errorMessage) => ({
  path,
  message: errorMessage,
});

const getFieldPath = (section, key) => `${section}.${key}`;

const applyValidation = ({ section, payload, schema }) => {
  const errors = {};

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      ...errors,
      [section]: normalizeError(section, 'Request payload must be an object'),
    };
  }

  const allowedKeys = new Set(schema.allowedKeys || Object.keys(schema.fields || {}));
  const required = new Set(schema.required || []);
  const fieldDefs = schema.fields || {};

  for (const key of Object.keys(payload)) {
    if (!allowedKeys.has(key)) {
      errors[getFieldPath(section, key)] = normalizeError(getFieldPath(section, key), 'Unknown field');
    }
  }

  for (const key of required) {
    if (payload[key] === undefined || payload[key] === null || payload[key] === '') {
      const fieldMessage = schema.fields?.[key]?.message || `${key} is required`;
      errors[getFieldPath(section, key)] = normalizeError(getFieldPath(section, key), fieldMessage);
    }
  }

  for (const [key, value] of Object.entries(fieldDefs)) {
    if (payload[key] === undefined) continue;

    const fieldValue = schema.fields[key].trim ? String(payload[key]).trim() : payload[key];
    const candidate = schema.fields[key].coerce ? schema.fields[key].coerce(fieldValue) : fieldValue;

    if (schema.fields[key].type && typeof candidate !== schema.fields[key].type) {
      errors[getFieldPath(section, key)] = normalizeError(
        getFieldPath(section, key),
        schema.fields[key].message || `${key} must be of type ${schema.fields[key].type}`,
      );
      continue;
    }

    if (schema.fields[key].custom && !schema.fields[key].custom(candidate)) {
      const fallbackMessage = schema.fields[key].message || `${key} is invalid`;
      errors[getFieldPath(section, key)] = normalizeError(getFieldPath(section, key), fallbackMessage);
    }

    if (schema.fields[key].sanitize && payload[key] !== undefined) {
      payload[key] = schema.fields[key].sanitize(payload[key]);
    }
  }

  return errors;
};

const validateRequest = (schema) => {
  return (req, res, next) => {
    const errors = {};

    if (schema.params) {
      Object.assign(errors, applyValidation({ section: 'params', payload: req.params || {}, schema: schema.params }));
    }

    if (schema.query) {
      Object.assign(errors, applyValidation({ section: 'query', payload: req.query || {}, schema: schema.query }));
    }

    if (schema.headers) {
      Object.assign(errors, applyValidation({ section: 'headers', payload: req.headers || {}, schema: schema.headers }));
    }

    if (schema.body) {
      Object.assign(errors, applyValidation({ section: 'body', payload: req.body || {}, schema: schema.body }));
    }

    if (Object.keys(errors).length > 0) {
      const validationError = new Error('Validation failed');
      validationError.statusCode = 400;
      validationError.errors = errors;
      return next(validationError);
    }

    if (schema.body?.fields) {
      for (const [key, definition] of Object.entries(schema.body.fields)) {
        if (req.body && Object.prototype.hasOwnProperty.call(req.body, key) && definition.trim) {
          req.body[key] = String(req.body[key]).trim();
        }
      }
    }

    return next();
  };
};

module.exports = {
  validateRequest,
  stripSecrets,
};
