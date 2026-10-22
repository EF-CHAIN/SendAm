import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import CorridorChart, { generateSampleCorridorData } from './CorridorChart';
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

describe('CorridorChart projection and empty states', () => {
  let ctx;
  let restoreSize;

  const sizeCanvases = (width, height) => {
    const proto = HTMLCanvasElement.prototype;
    const original = {
      clientWidth: Object.getOwnPropertyDescriptor(proto, 'clientWidth'),
      clientHeight: Object.getOwnPropertyDescriptor(proto, 'clientHeight'),
      rect: proto.getBoundingClientRect,
    };
    Object.defineProperty(proto, 'clientWidth', { configurable: true, get: () => width });
    Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => height });
    proto.getBoundingClientRect = () => ({ left: 0, top: 0, width, height, right: width, bottom: height });
    return () => {
      for (const key of ['clientWidth', 'clientHeight']) {
        if (original[key]) Object.defineProperty(proto, key, original[key]);
        else delete proto[key];
      }
      proto.getBoundingClientRect = original.rect;
    };
  };

  const numericArgs = () =>
    ['moveTo', 'lineTo', 'arc', 'fillText']
      .flatMap((method) => ctx[method].mock.calls)
      .flatMap((args) => args.filter((arg) => typeof arg === 'number'));

  beforeEach(() => {
    ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      scale: vi.fn(),
      clearRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      fill: vi.fn(),
      closePath: vi.fn(),
      fillText: vi.fn(),
      arc: vi.fn(),
      setLineDash: vi.fn(),
      createLinearGradient: vi.fn().mockReturnValue({ addColorStop: vi.fn() }),
    };
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(ctx);
    global.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    restoreSize = sizeCanvases(625, 320);
  });

  afterEach(() => {
    restoreSize();
    delete globalThis.Path2D;
  });

  it('shows an empty state instead of sample data for an empty series', () => {
    render(<CorridorChart data={[]} />);
    expect(screen.getByRole('status')).toHaveTextContent(/no corridor activity/i);
    expect(screen.getByRole('img', { hidden: true })).not.toBeVisible();
    expect(screen.getAllByText('$0')).toHaveLength(3);
    expect(screen.getByText('0 txs')).toBeInTheDocument();
    expect(ctx.moveTo).not.toHaveBeenCalled();
    expect(ctx.lineTo).not.toHaveBeenCalled();
  });

  it('falls back to sample data only when no series is supplied', () => {
    render(<CorridorChart />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(ctx.lineTo).toHaveBeenCalled();
    expect(numericArgs().every(Number.isFinite)).toBe(true);
  });

  it('draws a single-day dataset at the centre with finite coordinates', () => {
    render(<CorridorChart data={[{ label: 'Today', volume: 4000, txCount: 20, fees: 18 }]} />);
    expect(numericArgs().every(Number.isFinite)).toBe(true);
    // Volume and tx lines start at the centred x (65 + 500 / 2).
    expect(ctx.moveTo).toHaveBeenCalledWith(315, expect.any(Number));
    expect(ctx.fillText).toHaveBeenCalledWith('Today', 315, 300);
  });

  it('renders zero-volume days on the baseline without NaN', () => {
    render(
      <CorridorChart
        data={[
          { label: 'A', volume: 0, txCount: 0, fees: 0 },
          { label: 'B', volume: 0, txCount: 0, fees: 0 },
        ]}
      />
    );
    expect(numericArgs().every(Number.isFinite)).toBe(true);
    // Both volume points sit on the 280px baseline.
    expect(ctx.lineTo).toHaveBeenCalledWith(565, 280);
    expect(screen.getAllByText('$0')).toHaveLength(3);
  });

  it('treats missing and malformed values as zero', () => {
    render(
      <CorridorChart
        data={[
          { label: 'A' },
          { label: 'B', volume: null, txCount: undefined, fees: Number.NaN },
          { label: 'C', volume: 2000, txCount: 8, fees: 9 },
        ]}
      />
    );
    expect(numericArgs().every(Number.isFinite)).toBe(true);
    expect(screen.getByText('$2,000')).toBeInTheDocument();
    expect(screen.getByText('8 txs')).toBeInTheDocument();
  });

  it('draws with SVG path data when Path2D is available', () => {
    const paths = [];
    globalThis.Path2D = class {
      constructor(d) {
        paths.push(d);
      }
    };
    render(
      <CorridorChart
        data={[
          { label: 'A', volume: 0, txCount: 0, fees: 0 },
          { label: 'B', volume: 1150, txCount: 11.5, fees: 5 },
        ]}
      />
    );
    expect(paths).toContain('M65 280 L65 280 L565 62.61 L565 280 Z');
    expect(paths).toContain('M65 280 L565 62.61');
    for (const d of paths) expect(d).not.toMatch(/NaN|Infinity/);
  });

  it('highlights the hovered point with finite coordinates for a single day', () => {
    render(<CorridorChart data={[{ label: 'Today', volume: 4000, txCount: 20, fees: 18 }]} />);
    const canvas = screen.getByRole('img', { name: /financial chart/i });
    ctx.arc.mockClear();
    fireEvent.mouseMove(canvas, { clientX: 300, clientY: 100 });
    expect(screen.getByText('Tx Count:')).toBeInTheDocument();
    expect(screen.getByText('20 txs', { selector: '.font-mono' })).toBeInTheDocument();
    expect(ctx.arc).toHaveBeenCalled();
    for (const [x, y] of ctx.arc.mock.calls) {
      expect(x).toBe(315);
      expect(Number.isFinite(y)).toBe(true);
    }
    fireEvent.mouseLeave(canvas);
    expect(screen.queryByText('Tx Count:')).not.toBeInTheDocument();
  });

  it('ignores pointer positions outside the plot area', () => {
    render(<CorridorChart data={[{ label: 'Today', volume: 4000, txCount: 20, fees: 18 }]} />);
    const canvas = screen.getByRole('img', { name: /financial chart/i });
    fireEvent.mouseMove(canvas, { clientX: 10, clientY: 100 });
    expect(screen.queryByText('Tx Count:')).not.toBeInTheDocument();
  });
});
