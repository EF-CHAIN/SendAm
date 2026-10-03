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
});
