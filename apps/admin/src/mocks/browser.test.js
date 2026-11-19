import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockStart, mockStop, mockSetupWorker } = vi.hoisted(() => {
  const start = vi.fn().mockResolvedValue(undefined);
  const stop = vi.fn();
  const setup = vi.fn((...registeredHandlers) => ({
    start,
    stop,
    listHandlers: () => registeredHandlers,
  }));
  return { mockStart: start, mockStop: stop, mockSetupWorker: setup };
});

vi.mock('msw/browser', () => ({
  setupWorker: mockSetupWorker,
}));

import { worker, startMockWorker } from './browser.js';
import { handlers } from './handlers.js';

describe('MSW browser worker (apps/admin/src/mocks/browser.js)', () => {
  beforeEach(() => {
    mockStart.mockClear();
    mockStop.mockClear();
  });

  it('registers all REST handlers on the browser worker', () => {
    expect(mockSetupWorker).toHaveBeenCalledWith(...handlers);
    expect(worker).toBeDefined();
    expect(typeof worker.start).toBe('function');
    expect(typeof worker.stop).toBe('function');
    expect(handlers.length).toBeGreaterThanOrEqual(20);
  });

  it('does not start the worker when disabled', async () => {
    const started = await startMockWorker({ enabled: false });
    expect(started).toBe(false);
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('starts the worker with bypass mode when enabled', async () => {
    const started = await startMockWorker({ enabled: true });
    expect(started).toBe(true);
    expect(mockStart).toHaveBeenCalledWith({ onUnhandledRequest: 'bypass' });
  });

  it('serves deterministic mock data for offline admin endpoints', async () => {
    const [statsRes, userRes, eventsRes, verifyRes, revealRes] = await Promise.all([
      fetch('http://localhost:3002/api/admin/stats'),
      fetch('http://localhost:3002/api/admin/users/42'),
      fetch('http://localhost:3002/api/admin/events'),
      fetch('http://localhost:3002/api/admin/events/verify'),
      fetch('http://localhost:3002/api/admin/reveal/users/42', { method: 'POST' }),
    ]);

    expect(statsRes.status).toBe(200);
    expect((await statsRes.json()).data.totalUsers).toBe(42);

    expect(userRes.status).toBe(200);
    expect((await userRes.json()).data.id).toBe('42');

    expect(eventsRes.status).toBe(200);
    expect((await eventsRes.json()).data).toHaveLength(1);

    expect(verifyRes.status).toBe(200);
    expect((await verifyRes.json()).data.valid).toBe(true);

    expect(revealRes.status).toBe(200);
    expect((await revealRes.json()).data.revealed).toBe(true);
  });
});
