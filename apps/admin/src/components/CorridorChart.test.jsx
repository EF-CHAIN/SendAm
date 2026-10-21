import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import CorridorChart, { generateSampleCorridorData, prepareCorridorData } from './CorridorChart';

const now = new Date(2026, 9, 18, 12, 30);
const row = (timestamp, volume = 100, corridor = 'NGN') => ({ timestamp, volume, txCount: 2, fees: 1, corridor });
const history = [row(now), row(new Date(2026, 9, 16)), row(new Date(2026, 9, 1)), row(new Date(2026, 0, 1))];
const settle = () => act(() => { vi.advanceTimersByTime(50); });

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => { vi.useRealTimers(); });

describe('CorridorChart ranges', () => {
  it.each([['24H', 24], ['7D', 7], ['30D', 30], ['1Y', 12]])('generates %s with %i buckets', (range, count) => {
    const data = generateSampleCorridorData(range, 'NGN', now);
    expect(data).toHaveLength(count);
    expect(data.every(point => point.timestamp <= now)).toBe(true);
    expect(data[0].timestamp < data.at(-1).timestamp).toBe(true);
  });

  it.each([['24H', 100], ['7D', 200], ['30D', 300], ['1Y', 400]])('filters and aggregates supplied history for %s', (range, total) => {
    const data = prepareCorridorData(history, range, 'ALL', now);
    expect(data.reduce((sum, point) => sum + point.volume, 0)).toBe(total);
  });

  it('groups monthly totals across the year boundary and ignores invalid/future/out-of-range records', () => {
    const data = prepareCorridorData([
      row(new Date(2025, 10, 1), 10), row(new Date(2025, 10, 30), 20),
      row(new Date(2025, 9, 31), 999), row(new Date(2026, 9, 19), 999), row('invalid', 999),
    ], '1Y', 'ALL', now);
    expect(data[0]).toMatchObject({ volume: 30, txCount: 4, fees: 2 });
    expect(data.reduce((sum, point) => sum + point.volume, 0)).toBe(30);
  });

  it('defaults to 7D and replaces KPIs and chart together after each selection', () => {
    render(<CorridorChart data={history} />);
    expect(screen.getByRole('button', { name: 'Show 7D time range' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('$200')).toBeInTheDocument();
    const canvas = screen.getByLabelText('Interactive Canvas Financial Chart');
    const area = screen.getByLabelText('Corridor chart');
    for (const [range, total] of [['24H', 100], ['30D', 300], ['1Y', 400], ['7D', 200]]) {
      const button = screen.getByRole('button', { name: `Show ${range} time range` });
      fireEvent.click(button);
      expect(button).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('status')).toHaveTextContent(`Loading ${range}`);
      expect(area).toHaveClass('h-[320px]');
      expect(area).toHaveAttribute('aria-busy', 'true');
      expect(canvas).toHaveClass('invisible');
      settle();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(area).toHaveAttribute('aria-busy', 'false');
      expect(screen.getByText(`$${total}`)).toBeInTheDocument();
      expect(screen.getByLabelText('Interactive Canvas Financial Chart')).toBe(canvas);
    }
  });

  it('keeps the latest selection and corridor when controls change rapidly', () => {
    render(<CorridorChart data={[...history, row(now, 70, 'KES')]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show 1Y time range' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show 24H time range' }));
    fireEvent.click(screen.getByRole('button', { name: 'Filter corridor KES' }));
    settle();
    expect(screen.getByText('$70')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show 24H time range' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Show 24H time range' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('handles changed data and externally pending loads without displaying stale totals', () => {
    const { rerender } = render(<CorridorChart data={history} />);
    rerender(<CorridorChart data={history} loading />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading 7D');
    expect(screen.queryByText('$200')).not.toBeInTheDocument();
    rerender(<CorridorChart data={[row(now, 500)]} />);
    settle();
    expect(screen.getByText('$500')).toBeInTheDocument();
  });

  it('does not replace empty data or unmatched corridors with sample payments', () => {
    const { rerender } = render(<CorridorChart data={[]} />);
    expect(screen.getByRole('status')).toHaveTextContent('No payments');
    rerender(<CorridorChart data={history} />);
    fireEvent.click(screen.getByRole('button', { name: 'Filter corridor GHS' }));
    settle();
    expect(screen.getByRole('status')).toHaveTextContent('No payments');
  });

  it('cancels scheduled work on unmount', () => {
    const cancel = vi.spyOn(window, 'cancelAnimationFrame');
    const { unmount } = render(<CorridorChart />);
    fireEvent.click(screen.getByRole('button', { name: 'Show 1Y time range' }));
    unmount();
    expect(cancel).toHaveBeenCalled();
    cancel.mockRestore();
  });
});
