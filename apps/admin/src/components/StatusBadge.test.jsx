import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import StatusBadge from './StatusBadge';

describe('StatusBadge', () => {
  it.each([
    ['success', 'bg-green-100'],
    ['pending', 'bg-yellow-100'],
    ['failed', 'bg-red-100'],
  ])('renders a visible text label for the %s status', (status, colorClass) => {
    render(<StatusBadge status={status} />);

    const badge = screen.getByText(status);
    expect(badge).toBeVisible();
    expect(badge.textContent).toBe(status);
    expect(badge).toHaveClass(colorClass);
    expect(badge).toHaveAttribute('data-status', status);
  });

  it('matches the status case-insensitively but keeps the supplied text', () => {
    render(<StatusBadge status="SUCCESS" />);

    const badge = screen.getByText('SUCCESS');
    expect(badge).toHaveClass('bg-green-100');
    expect(badge).toHaveAttribute('data-status', 'success');
  });

  it('falls back to a neutral badge that still shows the unrecognised status text', () => {
    render(<StatusBadge status="reversed" />);

    const badge = screen.getByText('reversed');
    expect(badge).toHaveClass('bg-gray-100');
    expect(badge).toHaveAttribute('data-status', 'reversed');
  });

  it.each([[undefined], [null], ['']])('shows "Unknown" when the status is %p', (status) => {
    render(<StatusBadge status={status} />);

    const badge = screen.getByText('Unknown');
    expect(badge).toHaveClass('bg-gray-100');
    expect(badge).toHaveAttribute('data-status', 'unknown');
  });

  it('does not rely on colour alone: every variant carries a distinct hidden-from-AT icon', () => {
    const icons = ['success', 'pending', 'failed', 'other'].map((status) => {
      const { container, unmount } = render(<StatusBadge status={status} />);
      const svg = container.querySelector('svg');
      expect(svg).toHaveAttribute('aria-hidden', 'true');
      const markup = svg.innerHTML;
      unmount();
      return markup;
    });

    expect(new Set(icons).size).toBe(icons.length);
  });

  it('exposes only the status text as its accessible content', () => {
    render(<StatusBadge status="failed" />);

    expect(screen.getByText('failed')).toHaveTextContent(/^failed$/);
  });
});
