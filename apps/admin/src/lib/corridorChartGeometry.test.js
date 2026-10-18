import { describe, it, expect } from 'vitest';
import {
  CHART_PADDING,
  MIN_TX_SCALE,
  MIN_VOLUME_SCALE,
  SCALE_HEADROOM,
  buildAreaPath,
  buildLinePath,
  computeChartScales,
  computeTotals,
  nearestPointIndex,
  normalizeCorridorData,
  projectChartPoints,
} from './corridorChartGeometry';

const WIDTH = 625; // 500px plot width after 65 + 60 padding
const HEIGHT = 320; // 250px plot height after 30 + 40 padding
const PLOT_W = WIDTH - CHART_PADDING.left - CHART_PADDING.right;
const PLOT_H = HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom;
const BASELINE = CHART_PADDING.top + PLOT_H;

const point = (volume, txCount, label = 'd') => ({ label, volume, txCount, fees: volume * 0.0045 });

const allFinite = (layout) =>
  layout.points.every((p) => [p.x, p.volY, p.txY, p.barHeight].every(Number.isFinite));

describe('normalizeCorridorData', () => {
  it('returns [] for non-array input', () => {
    for (const input of [undefined, null, {}, 'x', 42]) {
      expect(normalizeCorridorData(input)).toEqual([]);
    }
  });

  it('coerces missing, null, NaN, infinite, negative and non-numeric values to 0', () => {
    const [p] = normalizeCorridorData([
      { label: 'a', volume: undefined, txCount: Number.NaN, fees: -5 },
    ]);
    expect(p).toMatchObject({ volume: 0, txCount: 0, fees: 0 });
    const [q] = normalizeCorridorData([
      { label: 'b', volume: Number.POSITIVE_INFINITY, txCount: null, fees: 'abc' },
    ]);
    expect(q).toMatchObject({ volume: 0, txCount: 0, fees: 0 });
  });

  it('keeps valid values, parses numeric strings and drops non-object entries', () => {
    const result = normalizeCorridorData([
      { label: 'a', volume: '1500', txCount: 12, fees: 6.75, corridor: 'NGN' },
      null,
      7,
      { volume: 10 },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ label: 'a', volume: 1500, txCount: 12, fees: 6.75, corridor: 'NGN' });
    expect(result[1].label).toBe('#2');
    expect(normalizeCorridorData([{ label: 3, volume: ' ' }])[0]).toMatchObject({ label: '3', volume: 0 });
  });
});

describe('computeChartScales', () => {
  it('uses the floors for empty and all-zero data', () => {
    const expected = { maxVolume: MIN_VOLUME_SCALE * SCALE_HEADROOM, maxTxs: MIN_TX_SCALE * SCALE_HEADROOM };
    expect(computeChartScales([])).toEqual(expected);
    expect(computeChartScales([point(0, 0), point(0, 0)])).toEqual(expected);
  });

  it('adds headroom above the largest values', () => {
    const scales = computeChartScales([point(2000, 40), point(5000, 20)]);
    expect(scales.maxVolume).toBeCloseTo(5000 * SCALE_HEADROOM);
    expect(scales.maxTxs).toBeCloseTo(40 * SCALE_HEADROOM);
  });
});

describe('projectChartPoints', () => {
  it('returns null when there is nothing to draw', () => {
    expect(projectChartPoints([], WIDTH, HEIGHT)).toBeNull();
    expect(projectChartPoints(undefined, WIDTH, HEIGHT)).toBeNull();
    expect(projectChartPoints([point(1, 1)], 0, 0)).toBeNull();
    expect(projectChartPoints([point(1, 1)], CHART_PADDING.left + CHART_PADDING.right, HEIGHT)).toBeNull();
    expect(projectChartPoints([point(1, 1)], Number.NaN, HEIGHT)).toBeNull();
  });

  it('spreads points evenly across the plot width', () => {
    const layout = projectChartPoints([point(100, 1), point(200, 2), point(300, 3)], WIDTH, HEIGHT);
    expect(layout.points.map((p) => p.x)).toEqual([65, 315, 565]);
    expect(layout.stepX).toBe(PLOT_W / 2);
    expect(allFinite(layout)).toBe(true);
  });

  it('centres a single-day dataset instead of pinning it to the left edge', () => {
    const layout = projectChartPoints([point(500, 5)], WIDTH, HEIGHT);
    expect(layout.points[0].x).toBe(CHART_PADDING.left + PLOT_W / 2);
    expect(layout.stepX).toBe(0);
    expect(allFinite(layout)).toBe(true);
  });

  it('renders zero-volume points on the baseline with zero bar height', () => {
    const layout = projectChartPoints([point(0, 0), point(0, 0)], WIDTH, HEIGHT);
    for (const p of layout.points) {
      expect(p.barHeight).toBe(0);
      expect(p.volY).toBe(BASELINE);
      expect(p.txY).toBe(BASELINE);
    }
    expect(layout.baselineY).toBe(BASELINE);
  });

  it('never produces NaN for missing values once normalised', () => {
    const raw = [{ label: 'a' }, { label: 'b', volume: null, txCount: undefined }, { label: 'c', volume: 900 }];
    const layout = projectChartPoints(normalizeCorridorData(raw), WIDTH, HEIGHT);
    expect(allFinite(layout)).toBe(true);
    expect(layout.points[0].barHeight).toBe(0);
    expect(layout.points[2].barHeight).toBeGreaterThan(0);
  });

  it('scales bar heights proportionally and keeps the peak below the top edge', () => {
    const layout = projectChartPoints([point(1000, 10), point(2000, 20)], WIDTH, HEIGHT);
    const [low, high] = layout.points;
    expect(high.barHeight).toBeCloseTo(low.barHeight * 2);
    expect(high.barHeight).toBeCloseTo(PLOT_H / SCALE_HEADROOM);
    expect(high.volY).toBeGreaterThan(CHART_PADDING.top);
    for (const p of layout.points) {
      expect(p.volY).toBeLessThanOrEqual(BASELINE);
      expect(p.txY).toBeLessThanOrEqual(BASELINE);
    }
  });

  it('handles extreme volumes without overflow', () => {
    const layout = projectChartPoints([point(Number.MAX_SAFE_INTEGER, 1e9), point(1, 1)], WIDTH, HEIGHT);
    expect(allFinite(layout)).toBe(true);
  });
});

describe('nearestPointIndex', () => {
  it('maps pointer offsets to the nearest index and clamps', () => {
    expect(nearestPointIndex(65, 3, WIDTH)).toBe(0);
    expect(nearestPointIndex(300, 3, WIDTH)).toBe(1);
    expect(nearestPointIndex(565, 3, WIDTH)).toBe(2);
    expect(nearestPointIndex(200, 1, WIDTH)).toBe(0);
  });

  it('returns -1 outside the plot, for no points or a bad offset', () => {
    expect(nearestPointIndex(10, 3, WIDTH)).toBe(-1);
    expect(nearestPointIndex(WIDTH - 10, 3, WIDTH)).toBe(-1);
    expect(nearestPointIndex(300, 0, WIDTH)).toBe(-1);
    expect(nearestPointIndex(Number.NaN, 3, WIDTH)).toBe(-1);
    expect(nearestPointIndex(100, 3, 100)).toBe(-1);
  });
});

describe('SVG path builders', () => {
  it('returns empty paths for no points', () => {
    expect(buildLinePath([], 'volY')).toBe('');
    expect(buildLinePath(undefined, 'volY')).toBe('');
    expect(buildAreaPath([], BASELINE)).toBe('');
  });

  it('builds a polyline and a closed area for a series', () => {
    const { points, baselineY } = projectChartPoints([point(0, 0), point(1150, 11.5)], WIDTH, HEIGHT);
    // The peak sits 250 / 1.15 = 217.39px above the 280px baseline.
    expect(buildLinePath(points, 'volY')).toBe('M65 280 L565 62.61');
    expect(buildLinePath(points, 'txY')).toBe('M65 280 L565 62.61');
    expect(buildAreaPath(points, baselineY)).toBe('M65 280 L65 280 L565 62.61 L565 280 Z');
  });

  it('builds a valid path for a single-day dataset', () => {
    const { points, baselineY } = projectChartPoints([point(0, 0)], WIDTH, HEIGHT);
    expect(buildLinePath(points, 'volY')).toBe('M315 280');
    expect(buildAreaPath(points, baselineY)).toBe('M315 280 L315 280 L315 280 Z');
  });

  it('never emits NaN, Infinity or exponent notation', () => {
    const data = normalizeCorridorData([{ volume: undefined }, { volume: 1e-9 }, { volume: 5e6, txCount: 3 }]);
    const { points, baselineY } = projectChartPoints(data, WIDTH, HEIGHT);
    for (const path of [buildLinePath(points, 'volY'), buildLinePath(points, 'txY'), buildAreaPath(points, baselineY)]) {
      expect(path).not.toMatch(/NaN|Infinity|e[+-]/);
      expect(path).toMatch(/^M[\d. LZ-]+$/);
    }
  });
});

describe('computeTotals', () => {
  it('sums the series and derives the average ticket', () => {
    expect(computeTotals([point(1000, 4), point(3000, 6)])).toEqual({
      totalVolume: 4000,
      totalTxs: 10,
      totalFees: 18,
      avgTxSize: 400,
    });
  });

  it('returns zeros for empty data and avoids dividing by zero', () => {
    expect(computeTotals([])).toEqual({ totalVolume: 0, totalTxs: 0, totalFees: 0, avgTxSize: 0 });
    expect(computeTotals([point(500, 0)]).avgTxSize).toBe(0);
  });
});
