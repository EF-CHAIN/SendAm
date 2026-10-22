import { describe, it, expect, afterEach } from 'vitest';
import { normalizeError } from '@shared/normalizeError.js';

const axiosError = (status, data, extra = {}) => {
  const err = new Error(`Request failed with status code ${status}`);
  err.name = 'AxiosError';
  err.response = { status, data, headers: {}, config: { url: '/api/x?token=abc' } };
  return Object.assign(err, extra);
};

const horizon = (resultCodes, status = 400) =>
  axiosError(status, {
    type: 'https://stellar.org/horizon-errors/transaction_failed',
    title: 'Transaction Failed',
    status,
    extras: { result_codes: resultCodes, envelope_xdr: 'AAAA-secret-xdr' },
  });

const setOnline = (value) =>
  Object.defineProperty(navigator, 'onLine', { value, configurable: true });

describe('normalizeError shape', () => {
  it.each([
    ['Error', new Error('boom')],
    ['string', 'oops'],
    ['number', 42],
    ['null', null],
    ['undefined', undefined],
    ['plain object', { foo: 'bar' }],
    ['array', [1, 2]],
    ['axios 500', axiosError(500, {})],
    ['network', { code: 'ERR_NETWORK', message: 'Network Error' }],
  ])('returns title, message and code for %s', (_label, thrown) => {
    const n = normalizeError(thrown);
    expect(typeof n.title).toBe('string');
    expect(n.title.length).toBeGreaterThan(0);
    expect(typeof n.message).toBe('string');
    expect(n.message.length).toBeGreaterThan(0);
    expect(typeof n.code).toBe('string');
    expect(n.userMessage).toBe(n.message);
    expect(typeof n.retryable).toBe('boolean');
    expect(n.internal).toBeDefined();
  });

  it('never throws, even for hostile objects', () => {
    const hostile = new Proxy({}, { get() { throw new Error('trap'); } });
    expect(() => normalizeError(hostile)).not.toThrow();
    expect(normalizeError(hostile).code).toBe('UNKNOWN_ERROR');
  });

  it('treats unknown thrown values as UNKNOWN_ERROR', () => {
    const n = normalizeError('something');
    expect(n.code).toBe('UNKNOWN_ERROR');
    expect(n.category).toBe('unknown');
    expect(n.correlationId).toBeNull();
    expect(n.internal.thrownType).toBe('string');
  });
});

describe('HTTP status codes', () => {
  it.each([
    [400, 'BAD_REQUEST', 'unknown', false],
    [401, 'AUTH_REQUIRED', 'auth', false],
    [403, 'FORBIDDEN', 'auth', false],
    [404, 'NOT_FOUND', 'notFound', false],
    [408, 'TIMEOUT', 'network', true],
    [409, 'CONFLICT', 'unknown', false],
    [422, 'VALIDATION_FAILED', 'unknown', false],
    [429, 'RATE_LIMITED', 'unknown', true],
    [500, 'SERVER_ERROR', 'server', true],
    [502, 'SERVICE_UNAVAILABLE', 'server', true],
    [503, 'SERVICE_UNAVAILABLE', 'server', true],
    [504, 'GATEWAY_TIMEOUT', 'server', true],
    [418, 'REQUEST_FAILED', 'unknown', false],
    [599, 'SERVER_ERROR', 'server', true],
  ])('maps %i to %s', (status, code, category, retryable) => {
    const n = normalizeError(axiosError(status, {}));
    expect(n.code).toBe(code);
    expect(n.category).toBe(category);
    expect(n.retryable).toBe(retryable);
  });

  it('reads a fetch-style { status } object and string statuses', () => {
    expect(normalizeError({ status: 404 }).code).toBe('NOT_FOUND');
    expect(normalizeError({ statusCode: 503 }).code).toBe('SERVICE_UNAVAILABLE');
    expect(normalizeError({ status: '429' }).code).toBe('RATE_LIMITED');
  });

  it('ignores out-of-range or non-numeric statuses', () => {
    expect(normalizeError({ status: 0 }).code).toBe('UNKNOWN_ERROR');
    expect(normalizeError({ status: 'abc' }).code).toBe('UNKNOWN_ERROR');
  });

  it('extracts the correlation ID and logs the backend code internally only', () => {
    const err = axiosError(422, { error: { code: 'validation_error', message: 'amount SELECT *' } });
    err.response.headers['x-correlation-id'] = 'abc-123';
    const n = normalizeError(err);
    expect(n.correlationId).toBe('abc-123');
    expect(n.internal.backendCode).toBe('validation_error');
    expect(n.internal.path).toBe('/api/x');
    expect(n.message).not.toContain('SELECT');
  });
});

describe('network failures', () => {
  afterEach(() => setOnline(true));

  it.each(['ERR_NETWORK', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND'])(
    'maps axios code %s to NETWORK_ERROR',
    (code) => {
      const n = normalizeError(Object.assign(new Error('x'), { code }));
      expect(n.code).toBe('NETWORK_ERROR');
      expect(n.category).toBe('network');
      expect(n.retryable).toBe(true);
    },
  );

  it('maps the Axios "Network Error" message', () => {
    expect(normalizeError({ message: 'Network Error' }).code).toBe('NETWORK_ERROR');
  });

  it.each(['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.'])(
    'maps the fetch failure "%s"',
    (message) => {
      expect(normalizeError(new TypeError(message)).code).toBe('NETWORK_ERROR');
    },
  );

  it('reports OFFLINE when the browser is offline', () => {
    setOnline(false);
    const n = normalizeError(new TypeError('Failed to fetch'));
    expect(n.code).toBe('OFFLINE');
    expect(n.retryable).toBe(true);
  });

  it('maps timeouts', () => {
    expect(normalizeError(Object.assign(new Error('timeout of 5000ms exceeded'), { code: 'ECONNABORTED' })).code).toBe('TIMEOUT');
    expect(normalizeError(Object.assign(new Error('t'), { code: 'ETIMEDOUT' })).code).toBe('TIMEOUT');
    const timeout = new Error('signal timed out');
    timeout.name = 'TimeoutError';
    expect(normalizeError(timeout).code).toBe('TIMEOUT');
  });

  it('maps cancellations', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(normalizeError(abort).code).toBe('REQUEST_CANCELED');
    expect(normalizeError(Object.assign(new Error('c'), { code: 'ERR_CANCELED' })).code).toBe('REQUEST_CANCELED');
  });

  it('falls back to the message heuristic for generic Errors', () => {
    expect(normalizeError(new Error('Unauthorized')).code).toBe('AUTH_REQUIRED');
    expect(normalizeError(new Error('fetch exploded')).code).toBe('NETWORK_ERROR');
  });
});

describe('Stellar Horizon errors', () => {
  it('prefers the operation code over the generic tx_failed', () => {
    const n = normalizeError(horizon({ transaction: 'tx_failed', operations: ['op_underfunded'] }));
    expect(n.code).toBe('op_underfunded');
    expect(n.category).toBe('stellar');
    expect(n.title).toBe('Insufficient funds');
    expect(n.retryable).toBe(false);
  });

  it('skips op_success entries in multi-operation transactions', () => {
    const n = normalizeError(horizon({ transaction: 'tx_failed', operations: ['op_success', 'op_no_trust'] }));
    expect(n.code).toBe('op_no_trust');
  });

  it('uses the transaction code when there are no operation codes', () => {
    const n = normalizeError(horizon({ transaction: 'tx_bad_seq' }));
    expect(n.code).toBe('tx_bad_seq');
    expect(n.retryable).toBe(true);
  });

  it.each([
    'tx_insufficient_balance', 'tx_insufficient_fee', 'tx_too_late', 'tx_bad_auth',
    'tx_no_source_account', 'op_no_destination', 'op_line_full', 'op_low_reserve', 'op_malformed',
  ])('has actionable copy for %s', (code) => {
    const n = normalizeError(horizon({ transaction: 'tx_failed', operations: [code] }));
    expect(n.code).toBe(code);
    expect(n.message).not.toBe('The Stellar network rejected this transaction. Check the details and try again.');
    expect(n.message.length).toBeGreaterThan(20);
  });

  it('gives unknown but well-formed codes a generic stellar message and keeps the code', () => {
    const n = normalizeError(horizon({ transaction: 'tx_failed', operations: ['op_brand_new'] }));
    expect(n.code).toBe('op_brand_new');
    expect(n.category).toBe('stellar');
    expect(n.title).toBe('Transaction failed');
  });

  it('ignores malformed codes so odd payloads cannot inject text', () => {
    const n = normalizeError(horizon({ transaction: '<script>alert(1)</script>', operations: [{}] }, 400));
    expect(n.code).toBe('BAD_REQUEST');
  });

  it('reads result codes from a bare object and from error.data', () => {
    expect(normalizeError({ extras: { result_codes: { operations: ['op_no_trust'] } } }).code).toBe('op_no_trust');
    expect(normalizeError({ data: { extras: { result_codes: { transaction: 'tx_too_late' } } } }).code).toBe('tx_too_late');
  });

  it('never leaks the envelope XDR or raw payload', () => {
    const n = normalizeError(horizon({ transaction: 'tx_failed', operations: ['op_underfunded'] }));
    const serialized = JSON.stringify(n);
    expect(serialized).not.toContain('AAAA-secret-xdr');
    expect(n.internal.stellarCode).toBe('op_underfunded');
  });

  it('still maps Horizon HTTP failures without result codes (e.g. 504 timeout)', () => {
    expect(normalizeError(axiosError(504, { type: 'timeout' })).code).toBe('GATEWAY_TIMEOUT');
  });
});

describe('safety', () => {
  it('does not expose internal.message or stacks in user-facing fields', () => {
    const n = normalizeError(new Error('SELECT * FROM users WHERE id=1'));
    for (const text of [n.title, n.message, n.userMessage]) {
      expect(text).not.toContain('SELECT');
      expect(text).not.toMatch(/\.(jsx?|tsx?|mjs):\d+/);
    }
    expect(n.internal.message).toContain('SELECT');
  });
});
