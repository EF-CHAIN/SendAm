import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import ChatMockup from './ChatMockup.jsx';

describe('ChatMockup', () => {
  it('renders the chat header with the SendAm contact and presence', () => {
    render(<ChatMockup />);
    expect(screen.getByText('SendAm')).toBeInTheDocument();
    expect(screen.getByText('online')).toBeInTheDocument();
  });

  it('renders the mocked conversation in order', () => {
    const { container } = render(<ChatMockup />);
    const transcript = container.textContent;
    const turns = [
      'Send 25000 NGN to Ada',
      'Reply with your PIN to confirm.',
      'Payment sent.',
      'Receipt: SDA-9284',
      'voice note: what is my balance',
      'stellar: 340 XLM',
    ];

    let cursor = -1;
    turns.forEach((turn) => {
      const index = transcript.indexOf(turn);
      expect(index, `"${turn}" should appear after the previous turn`).toBeGreaterThan(cursor);
      cursor = index;
    });
  });

  it('masks the PIN reply instead of showing digits', () => {
    const { container } = render(<ChatMockup />);
    expect(container.textContent).toContain('****');
  });

  it('renders the composer placeholder', () => {
    render(<ChatMockup />);
    expect(screen.getByText('Message or voice note')).toBeInTheDocument();
  });

  it('gives every image an alt attribute', () => {
    const { container } = render(<ChatMockup />);
    const images = container.querySelectorAll('img');
    expect(images.length).toBeGreaterThan(0);
    images.forEach((img) => {
      expect(img).toHaveAttribute('alt');
    });
  });

  it('marks the decorative avatar and status icons as decorative (alt="")', () => {
    // The avatar sits next to the visible "SendAm" name and the status-bar
    // icons are chrome, so none of them carry information of their own.
    const { container } = render(<ChatMockup />);
    const images = Array.from(container.querySelectorAll('img'));
    const avatar = images.find((img) => img.getAttribute('src') === '/logo-sent.svg');
    expect(avatar).toBeDefined();

    images.forEach((img) => {
      expect(img).toHaveAttribute('alt', '');
    });
    // Decorative images are removed from the accessibility tree entirely.
    expect(screen.queryAllByRole('img')).toHaveLength(0);
  });

  it('renders receipt ticks for all outbound (user) messages', () => {
    render(<ChatMockup autoAnimate={false} />);
    const ticks = screen.getAllByTestId('receipt-tick');
    expect(ticks).toHaveLength(3);
    ticks.forEach((tick) => {
      expect(tick).toHaveAttribute('data-state', 'read');
      expect(tick).toHaveAttribute('title', 'Read and settled');
    });
  });

  it('animates checkmark states sequentially through sending, sent, delivered, and read', async () => {
    const { vi } = await import('vitest');
    vi.useFakeTimers();

    const { act } = await import('@testing-library/react');
    render(<ChatMockup autoAnimate={true} loop={false} />);

    // Initially at t=0
    let ticks = screen.getAllByTestId('receipt-tick');
    expect(ticks[0]).toHaveAttribute('data-state', 'sending');
    expect(ticks[1]).toHaveAttribute('data-state', 'sending');
    expect(ticks[2]).toHaveAttribute('data-state', 'sending');

    // Advance to 600ms (message 0 is sent)
    act(() => {
      vi.advanceTimersByTime(600);
    });
    ticks = screen.getAllByTestId('receipt-tick');
    expect(ticks[0]).toHaveAttribute('data-state', 'sent');

    // Advance to 1200ms (message 0 is delivered)
    act(() => {
      vi.advanceTimersByTime(600);
    });
    ticks = screen.getAllByTestId('receipt-tick');
    expect(ticks[0]).toHaveAttribute('data-state', 'delivered');

    // Advance to 1800ms (message 0 is read)
    act(() => {
      vi.advanceTimersByTime(600);
    });
    ticks = screen.getAllByTestId('receipt-tick');
    expect(ticks[0]).toHaveAttribute('data-state', 'read');

    // Advance to 3600ms (message 1 is read)
    act(() => {
      vi.advanceTimersByTime(1800);
    });
    ticks = screen.getAllByTestId('receipt-tick');
    expect(ticks[1]).toHaveAttribute('data-state', 'read');

    // Advance to 5400ms (message 2 is read)
    act(() => {
      vi.advanceTimersByTime(1800);
    });
    ticks = screen.getAllByTestId('receipt-tick');
    expect(ticks[2]).toHaveAttribute('data-state', 'read');

    vi.useRealTimers();
  });

  it('keeps decorative tick SVGs aria-hidden from screen readers', () => {
    render(<ChatMockup autoAnimate={false} />);
    const ticks = screen.getAllByTestId('receipt-tick');
    ticks.forEach((tick) => {
      const svg = tick.querySelector('svg');
      expect(svg).toHaveAttribute('aria-hidden', 'true');
    });
  });

  it('respects prefers-reduced-motion by defaulting directly to read state', () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = (query) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    });

    try {
      render(<ChatMockup autoAnimate={true} />);
      const ticks = screen.getAllByTestId('receipt-tick');
      ticks.forEach((tick) => {
        expect(tick).toHaveAttribute('data-state', 'read');
      });
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it('cleans up animation timers on unmount without errors', () => {
    const { unmount } = render(<ChatMockup autoAnimate={true} />);
    expect(() => unmount()).not.toThrow();
  });
});
