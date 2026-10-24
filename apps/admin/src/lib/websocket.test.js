import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketManager } from './websocket';

describe('WebSocketManager', () => {
  let mockWsInstance;

  beforeEach(() => {
    vi.useFakeTimers();
    mockWsInstance = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      close: vi.fn(),
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    vi.stubGlobal('WebSocket', vi.fn().mockImplementation(() => mockWsInstance));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('connects, updates state to connected, and emits open event', () => {
    const manager = new WebSocketManager('ws://localhost:3002/ws');
    const stateCallback = vi.fn();
    manager.onStateChange(stateCallback);

    manager.connect();
    expect(stateCallback).toHaveBeenCalledWith('connecting');

    mockWsInstance.onopen();
    expect(stateCallback).toHaveBeenCalledWith('connected');
    expect(manager.state).toBe('connected');
  });

  it('dispatches incoming transaction messages to event listeners', () => {
    const manager = new WebSocketManager('ws://localhost:3002/ws');
    const txListener = vi.fn();
    manager.on('transaction_settled', txListener);

    manager.connect();
    mockWsInstance.onopen();

    const payload = { id: 'tx_999', amount: '50.00', status: 'success' };
    mockWsInstance.onmessage({
      data: JSON.stringify({
        type: 'transaction_settled',
        payload,
      }),
    });

    expect(txListener).toHaveBeenCalledWith(payload);
  });

  it('handles automatic reconnection on unexpected disconnection', () => {
    const manager = new WebSocketManager('ws://localhost:3002/ws', { reconnectBaseMs: 500 });
    const stateCallback = vi.fn();
    manager.onStateChange(stateCallback);

    manager.connect();
    mockWsInstance.onopen();

    // Server drops abnormally with code 1006
    mockWsInstance.onclose({ code: 1006 });
    expect(stateCallback).toHaveBeenCalledWith('reconnecting');

    vi.advanceTimersByTime(2000);
    // Should attempt reconnection
    expect(WebSocket).toHaveBeenCalledTimes(2);
  });

  it('manages ping/pong heartbeats and times out when pong is not received', () => {
    const manager = new WebSocketManager('ws://localhost:3002/ws', {
      heartbeatIntervalMs: 1000,
      heartbeatTimeoutMs: 500,
    });

    manager.connect();
    mockWsInstance.onopen();

    // Advance to trigger ping
    vi.advanceTimersByTime(1100);
    expect(mockWsInstance.send).toHaveBeenCalledWith(JSON.stringify({ type: 'ping' }));

    // Advance past timeout without pong -> forces close
    vi.advanceTimersByTime(600);
    expect(mockWsInstance.close).toHaveBeenCalled();
  });
});
