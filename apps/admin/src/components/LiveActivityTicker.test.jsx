import { render, screen, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import LiveActivityTicker from './LiveActivityTicker';
import { getWebSocketManager } from '@/lib/websocket';

vi.mock('@/lib/websocket', () => {
  const listeners = new Map();
  return {
    getWebSocketManager: vi.fn(() => ({
      connect: vi.fn(),
      on: vi.fn((event, cb) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event).add(cb);
        return () => listeners.get(event)?.delete(cb);
      }),
      emit: (event, data) => {
        listeners.get(event)?.forEach((cb) => cb(data));
      },
    })),
  };
});

describe('LiveActivityTicker Component', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('renders heading, initial items, and flashing pulse dot', () => {
    render(<LiveActivityTicker simulateIntervalMs={0} />);

    expect(screen.getByRole('heading', { level: 2, name: /live activity/i })).toBeInTheDocument();
    expect(screen.getByTestId('ticker-status-live')).toHaveTextContent('Live');
    expect(screen.getByRole('button', { name: /pause live transaction stream/i })).toBeInTheDocument();

    const items = screen.getAllByTestId('live-activity-item');
    expect(items.length).toBeGreaterThan(0);
  });

  it('renders with custom initialItems', () => {
    const customItems = [
      {
        id: 'cust-1',
        txHash: 'deadbeef',
        amount: '999.00',
        asset: 'USDC',
        type: 'Custom Transfer',
        senderPhone: '+234 800 000 0001',
        recipientPhone: '+234 800 000 0002',
        status: 'Completed',
        createdAt: new Date().toISOString(),
      },
    ];

    render(<LiveActivityTicker initialItems={customItems} simulateIntervalMs={0} />);

    expect(screen.getByText('999.00 USDC')).toBeInTheDocument();
    expect(screen.getByText('+234 800 000 0002')).toBeInTheDocument();
    expect(screen.getByText('Custom Transfer')).toBeInTheDocument();
  });

  it('smoothly top-inserts simulated payments at configured intervals', () => {
    const customItems = [
      {
        id: 'old-1',
        txHash: '11111111',
        amount: '10.00',
        asset: 'USDC',
        type: 'Old Payment',
        senderPhone: '+234 111',
        recipientPhone: '+234 222',
        status: 'Completed',
        createdAt: new Date().toISOString(),
      },
    ];

    render(<LiveActivityTicker initialItems={customItems} simulateIntervalMs={2000} isSimulated={true} />);

    expect(screen.getAllByTestId('live-activity-item')).toHaveLength(1);

    // Fast-forward interval
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    const itemsAfterTick = screen.getAllByTestId('live-activity-item');
    expect(itemsAfterTick.length).toBe(2);
    // The top item should be the new one, and the old one should be second
    expect(itemsAfterTick[1]).toHaveTextContent('Old Payment');
  });

  it('respects maxItems cap to maintain O(1) space bound', () => {
    render(<LiveActivityTicker initialItems={[]} maxItems={3} simulateIntervalMs={1000} isSimulated={true} />);

    // Trigger 5 simulation ticks
    for (let i = 0; i < 5; i++) {
      act(() => {
        vi.advanceTimersByTime(1000);
      });
    }

    const items = screen.getAllByTestId('live-activity-item');
    expect(items.length).toBe(3);
  });

  it('pauses stream when dedicated pause button is clicked', () => {
    const customItems = [
      {
        id: 'tx-1',
        txHash: 'aaaaaaaa',
        amount: '20.00',
        asset: 'USDC',
        type: 'Seed Tx',
        senderPhone: '+234 111',
        recipientPhone: '+234 222',
        status: 'Completed',
        createdAt: new Date().toISOString(),
      },
    ];

    render(<LiveActivityTicker initialItems={customItems} simulateIntervalMs={1000} isSimulated={true} />);

    const pauseBtn = screen.getByRole('button', { name: /pause live transaction stream/i });
    expect(pauseBtn).toHaveTextContent('Pause');

    // Click Pause
    fireEvent.click(pauseBtn);

    expect(screen.getByTestId('ticker-status-paused')).toHaveTextContent('Paused');
    expect(screen.getByRole('button', { name: /resume live transaction stream/i })).toHaveTextContent('Resume');

    // Advance time while paused
    act(() => {
      vi.advanceTimersByTime(3000);
    });

    // Count must not increase while paused
    expect(screen.getAllByTestId('live-activity-item')).toHaveLength(1);

    // Click Resume
    const resumeBtn = screen.getByRole('button', { name: /resume live transaction stream/i });
    fireEvent.click(resumeBtn);

    expect(screen.getByTestId('ticker-status-live')).toHaveTextContent('Live');

    // Advance time after resuming
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(screen.getAllByTestId('live-activity-item')).toHaveLength(2);
  });

  it('inserts real-time transactions from WebSocket manager', () => {
    const ws = getWebSocketManager();
    render(<LiveActivityTicker initialItems={[]} simulateIntervalMs={0} />);

    act(() => {
      ws.emit('transaction', {
        transaction: {
          _id: 'ws-tx-999',
          txHash: 'feedbeef',
          amount: '750.00',
          asset: 'USDC',
          type: 'WhatsApp Voice-to-Cash',
          recipientPhoneNumber: '+234 999 888 7777',
          status: 'Completed',
          createdAt: new Date().toISOString(),
        },
      });
    });

    expect(screen.getByText('750.00 USDC')).toBeInTheDocument();
    expect(screen.getByText('+234 999 888 7777')).toBeInTheDocument();
  });

  it('renders simulated transaction fields matching SendAm schema', () => {
    render(<LiveActivityTicker initialItems={[]} simulateIntervalMs={1000} isSimulated={true} />);

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    const item = screen.getByTestId('live-activity-item');
    expect(item).toBeInTheDocument();
    // Should have amount, status, and time
    expect(item.textContent).toMatch(/(USDC|NGN|XLM)/);
    expect(item.textContent).toMatch(/Completed/);
  });
});
