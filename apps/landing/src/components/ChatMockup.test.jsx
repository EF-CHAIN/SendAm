import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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

  it('plays, pauses, and scrubs the voice message', () => {
    render(<ChatMockup />);
    const seek = screen.getByRole('slider', { name: /seek voice message/i });

    expect(screen.getByText('0:00')).toBeInTheDocument();
    expect(screen.getByText('0:14')).toBeInTheDocument();
    fireEvent.change(seek, { target: { value: '9' } });
    expect(screen.getByText('0:09')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /play voice note/i }));
    expect(screen.getByRole('button', { name: /pause voice note/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /pause voice note/i }));
    expect(screen.getByRole('button', { name: /play voice note/i })).toBeInTheDocument();
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
});
