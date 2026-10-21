import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import StellarAddress from '@shared/StellarAddress.jsx';

const ADDRESS = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTWXYZ';

describe('StellarAddress', () => {
  let writeText;

  beforeEach(() => {
    vi.useFakeTimers();
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('truncates to the first 4 and last 4 characters', () => {
    render(<StellarAddress address={ADDRESS} />);
    expect(screen.getByText('GABC...WXYZ')).toBeTruthy();
    expect(screen.queryByText(ADDRESS)).toBeNull();
  });

  it('shows the full address as the tooltip', () => {
    render(<StellarAddress address={ADDRESS} />);
    expect(screen.getByRole('button').getAttribute('title')).toBe(ADDRESS);
  });

  it('copies the full address and shows a checkmark, then resets', async () => {
    render(<StellarAddress address={ADDRESS} />);
    expect(screen.getByTestId('copy-icon')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });

    expect(writeText).toHaveBeenCalledWith(ADDRESS);
    expect(screen.getByTestId('copied-icon')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Address copied');

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByTestId('copy-icon')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('falls back to execCommand when the Clipboard API rejects', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    document.execCommand = vi.fn().mockReturnValue(true);

    render(<StellarAddress address={ADDRESS} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });

    expect(document.execCommand).toHaveBeenCalledWith('copy');
    expect(screen.getByTestId('copied-icon')).toBeTruthy();
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('reports failure and keeps the copy icon when copying is impossible', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    document.execCommand = vi.fn().mockReturnValue(false);

    render(<StellarAddress address={ADDRESS} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });

    expect(screen.queryByTestId('copied-icon')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Copy failed');
  });

  it('renders nothing for empty or non-string addresses', () => {
    const { container, rerender } = render(<StellarAddress address="" />);
    expect(container.firstChild).toBeNull();
    rerender(<StellarAddress address={undefined} />);
    expect(container.firstChild).toBeNull();
    rerender(<StellarAddress address={12345} />);
    expect(container.firstChild).toBeNull();
  });

  it('does not truncate values too short to shorten', () => {
    render(<StellarAddress address="GABCDEF" />);
    expect(screen.getByText('GABCDEF')).toBeTruthy();
  });

  it('does not update state after unmounting', async () => {
    const { unmount } = render(<StellarAddress address={ADDRESS} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    unmount();
    expect(() => vi.advanceTimersByTime(5000)).not.toThrow();
  });
});
