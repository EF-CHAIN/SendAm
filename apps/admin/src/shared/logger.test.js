import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger, redact, LOG_BUFFER_SIZE } from '@shared/logger.js';

describe('logger ring buffer', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    logger.clearLogs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps a buffer size of 100', () => {
    expect(LOG_BUFFER_SIZE).toBe(100);
  });

  it('starts empty', () => {
    expect(logger.getRecentLogs()).toEqual([]);
  });

  it('records info, warn and error entries in order with level and message', () => {
    logger.info('one');
    logger.warn('two');
    logger.error('three', { status: 500 });

    const logs = logger.getRecentLogs();
    expect(logs.map((l) => [l.level, l.message])).toEqual([
      ['info', 'one'],
      ['warn', 'two'],
      ['error', 'three'],
    ]);
    expect(logs[2].status).toBe(500);
    expect(logs[0].source).toBe('frontend');
    expect(typeof logs[0].timestamp).toBe('string');
  });

  it('still writes to the console', () => {
    logger.error('boom');
    logger.warn('careful');
    logger.info('fyi');
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.info).toHaveBeenCalledTimes(1);
  });

  it('keeps exactly the last 100 entries when more are written, oldest first', () => {
    for (let i = 0; i < 250; i += 1) logger.info(`msg ${i}`);

    const logs = logger.getRecentLogs();
    expect(logs).toHaveLength(100);
    expect(logs[0].message).toBe('msg 150');
    expect(logs[99].message).toBe('msg 249');
  });

  it('holds all entries up to and including the capacity', () => {
    for (let i = 0; i < 100; i += 1) logger.info(`msg ${i}`);
    const logs = logger.getRecentLogs();
    expect(logs).toHaveLength(100);
    expect(logs[0].message).toBe('msg 0');
    expect(logs[99].message).toBe('msg 99');
  });

  it('stores redacted records, never raw secrets', () => {
    logger.error('login failed', { token: 'abc', nested: { password: 'p', ok: 1 } });

    const [entry] = logger.getRecentLogs();
    expect(entry.token).toBe('[REDACTED]');
    expect(entry.nested.password).toBe('[REDACTED]');
    expect(entry.nested.ok).toBe(1);
    expect(JSON.stringify(logger.getRecentLogs())).not.toContain('"abc"');
  });

  it('returns a copy so callers cannot mutate the buffer', () => {
    logger.info('keep me', { nested: { a: 1 } });

    const first = logger.getRecentLogs();
    first[0].message = 'tampered';
    first[0].nested.a = 99;
    first.push({ level: 'info' });

    const second = logger.getRecentLogs();
    expect(second).toHaveLength(1);
    expect(second[0].message).toBe('keep me');
    expect(second[0].nested.a).toBe(1);
  });

  it('survives circular context without throwing', () => {
    const ctx = { name: 'loop' };
    ctx.self = ctx;
    expect(() => logger.error('circular', ctx)).not.toThrow();
    expect(logger.getRecentLogs()[0].self).toBe('[Circular]');
  });

  it('clearLogs empties the buffer and it keeps working afterwards', () => {
    logger.info('a');
    logger.clearLogs();
    expect(logger.getRecentLogs()).toEqual([]);
    logger.info('b');
    expect(logger.getRecentLogs().map((l) => l.message)).toEqual(['b']);
  });
});

describe('logger.downloadLogs', () => {
  let blobs;
  let anchors;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    logger.clearLogs();
    blobs = [];
    anchors = [];
    // Capture the payload directly: jsdom's FileReader would hang under fake timers.
    vi.stubGlobal('Blob', class FakeBlob {
      constructor(parts, options) {
        this.text = parts.join('');
        this.type = options.type;
      }
    });
    window.URL.createObjectURL = vi.fn((blob) => {
      blobs.push(blob);
      return 'blob:test';
    });
    window.URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click() {
      anchors.push({ href: this.href, download: this.download });
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('downloads a JSON file with the buffered logs', () => {
    logger.info('hello', { apiKey: 'secret-value' });

    const name = logger.downloadLogs();

    expect(name).toMatch(/^sendam-logs-.*\.json$/);
    expect(anchors).toEqual([{ href: 'blob:test', download: name }]);
    expect(blobs[0].type).toBe('application/json');

    const parsed = JSON.parse(blobs[0].text);
    expect(parsed.count).toBe(1);
    expect(parsed.capacity).toBe(100);
    expect(typeof parsed.exportedAt).toBe('string');
    expect(parsed.logs[0].message).toBe('hello');
    expect(parsed.logs[0].apiKey).toBe('[REDACTED]');
    expect(blobs[0].text).not.toContain('secret-value');
  });

  it('uses a custom filename and cleans up the DOM and object URL', () => {
    const name = logger.downloadLogs('ticket-42.json');

    expect(name).toBe('ticket-42.json');
    expect(document.querySelector('a[download]')).toBeNull();
    vi.runAllTimers();
    expect(window.URL.revokeObjectURL).toHaveBeenCalledWith('blob:test');
  });

  it('exports an empty list when nothing was logged', () => {
    logger.downloadLogs();
    const parsed = JSON.parse(blobs[0].text);
    expect(parsed.count).toBe(0);
    expect(parsed.logs).toEqual([]);
  });

  it('does not crash on values JSON cannot represent', () => {
    logger.info('big', { amount: 10n });
    expect(() => logger.downloadLogs()).not.toThrow();
    const parsed = JSON.parse(blobs[0].text);
    expect(parsed.logs[0].amount).toBe('10');
  });

  it('returns null and does nothing when the browser APIs are unavailable', () => {
    window.URL.createObjectURL = undefined;
    expect(logger.downloadLogs()).toBeNull();
    expect(anchors).toHaveLength(0);
  });
});

describe('redact (unchanged behaviour)', () => {
  it('redacts sensitive keys case-insensitively', () => {
    expect(redact({ Password: 'x', user: 'ada' })).toEqual({ Password: '[REDACTED]', user: 'ada' });
  });
});
