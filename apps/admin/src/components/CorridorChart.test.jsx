import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import CorridorChart, { generateSampleCorridorData } from './CorridorChart';

describe('CorridorChart Component', () => {
  beforeEach(() => {
    // Mock HTMLCanvasElement getContext
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({
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
      createLinearGradient: vi.fn().mockReturnValue({
        addColorStop: vi.fn(),
      }),
    });

    // Mock ResizeObserver
    global.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  it('generates sample corridor data with correct point counts', () => {
    const dailyData = generateSampleCorridorData('daily', 'NGN');
    expect(dailyData.length).toBe(30);

    const hourlyData = generateSampleCorridorData('hourly', 'ALL');
    expect(hourlyData.length).toBe(24);

    const weeklyData = generateSampleCorridorData('weekly', 'KES');
    expect(weeklyData.length).toBe(12);
  });

  it('renders chart title, interval selectors, corridor filters, and metric KPIs', () => {
    render(<CorridorChart title="Corridor Volume & Fee Analytics" />);

    expect(screen.getByText('Corridor Volume & Fee Analytics')).toBeInTheDocument();
    expect(screen.getByText('All Corridors')).toBeInTheDocument();
    expect(screen.getByText('NGN')).toBeInTheDocument();
    expect(screen.getByText('KES')).toBeInTheDocument();
    expect(screen.getByText('GHS')).toBeInTheDocument();

    expect(screen.getByText('daily')).toBeInTheDocument();
    expect(screen.getByText('hourly')).toBeInTheDocument();
    expect(screen.getByText('weekly')).toBeInTheDocument();

    expect(screen.getByText('Total Volume')).toBeInTheDocument();
    expect(screen.getByText('Total Transactions')).toBeInTheDocument();
    expect(screen.getByText('Est. Revenue / Fees')).toBeInTheDocument();
  });

  it('handles switching corridor and interval tabs', () => {
    render(<CorridorChart />);

    const ngnBtn = screen.getByRole('button', { name: /Filter corridor NGN/i });
    fireEvent.click(ngnBtn);
    expect(ngnBtn).toHaveClass('bg-white');

    const hourlyBtn = screen.getByRole('button', { name: /Select hourly interval/i });
    fireEvent.click(hourlyBtn);
    expect(hourlyBtn).toHaveClass('bg-indigo-600');
  });

  it('renders custom provided time-series dataset', () => {
    const mockData = [
      { timestamp: new Date(), label: 'Day 1', volume: 50000, txCount: 150, fees: 225, corridor: 'NGN' },
      { timestamp: new Date(), label: 'Day 2', volume: 75000, txCount: 200, fees: 337.5, corridor: 'NGN' },
    ];

    render(<CorridorChart data={mockData} />);
    expect(screen.getByText('$125,000')).toBeInTheDocument();
    expect(screen.getByText('350 txs')).toBeInTheDocument();
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
