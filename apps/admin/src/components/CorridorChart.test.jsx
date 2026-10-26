import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import CorridorChart, { generateSampleCorridorData, prepareCorridorData, formatLatency } from './CorridorChart';

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

describe('CorridorChart tooltip', () => {
  const latencyRow = (timestamp, volume, txCount, avgLatencyMs) => ({ timestamp, volume, txCount, fees: 1, corridor: 'NGN', avgLatencyMs });

  it('weights bucket latency by transaction count and leaves it null when unreported', () => {
    const data = prepareCorridorData([
      latencyRow(new Date(2026, 9, 18, 9), 100, 1, 2000),
      latencyRow(new Date(2026, 9, 18, 10), 100, 3, 6000),
      row(new Date(2026, 9, 17)),
    ], '7D', 'ALL', now);
    expect(data.at(-1).avgLatencyMs).toBe(5000);
    expect(data.at(-2).avgLatencyMs).toBeNull();
  });

  it('includes a full date in every bucket', () => {
    const data = generateSampleCorridorData('7D', 'NGN', now);
    expect(data.at(-1).fullLabel).toContain('2026');
    expect(data.every(point => Number.isFinite(point.avgLatencyMs))).toBe(true);
  });

  it.each([[undefined, 'N/A'], [null, 'N/A'], [450, '450 ms'], [4500, '4.5 s'], [90000, '1.5 min']])('formats latency %s as %s', (ms, text) => {
    expect(formatLatency(ms)).toBe(text);
  });

  it('shows date, volume, transaction count and average settlement on hover and hides on leave', () => {
    const widthSpy = vi.spyOn(HTMLCanvasElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
    render(<CorridorChart data={[latencyRow(now, 250, 4, 3000)]} />);
    const canvas = screen.getByLabelText('Interactive Canvas Financial Chart');
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 320, width: 800, height: 320 });
    expect(screen.queryByTestId('corridor-chart-tooltip')).not.toBeInTheDocument();
    fireEvent.mouseMove(canvas, { clientX: 740, clientY: 100 });
    const tooltip = screen.getByTestId('corridor-chart-tooltip');
    expect(tooltip).toHaveTextContent('2026');
    expect(tooltip).toHaveTextContent('$250');
    expect(tooltip).toHaveTextContent('4 txs');
    expect(tooltip).toHaveTextContent('Avg Settlement:3.0 s');
    fireEvent.mouseLeave(canvas);
    expect(screen.queryByTestId('corridor-chart-tooltip')).not.toBeInTheDocument();
    widthSpy.mockRestore();
  });
});
