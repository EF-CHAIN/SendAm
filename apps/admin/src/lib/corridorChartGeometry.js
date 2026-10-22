// Pure geometry for CorridorChart: data normalisation, axis scaling and
// coordinate projection. Kept free of React and canvas so it can be unit
// tested, and so every coordinate the chart draws is guaranteed finite.

export const CHART_PADDING = Object.freeze({ top: 30, right: 60, bottom: 40, left: 65 });

/** Axis floors so an all-zero dataset still has a sensible, non-zero scale. */
export const MIN_VOLUME_SCALE = 1000;
export const MIN_TX_SCALE = 10;
/** Headroom above the largest value so the peak never touches the top edge. */
export const SCALE_HEADROOM = 1.15;

const toNonNegativeNumber = (value) => {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) && number > 0 ? number : 0;
};

/**
 * Coerces a raw series into points with finite, non-negative `volume`,
 * `txCount` and `fees`. Missing, null, NaN, infinite and negative values
 * become 0; non-object entries are dropped. Returns `[]` for anything that is
 * not an array.
 */
export function normalizeCorridorData(data) {
  if (!Array.isArray(data)) return [];
  return data
    .filter((point) => point !== null && typeof point === 'object')
    .map((point, index) => ({
      ...point,
      label: point.label === undefined || point.label === null ? `#${index + 1}` : String(point.label),
      volume: toNonNegativeNumber(point.volume),
      txCount: toNonNegativeNumber(point.txCount),
      fees: toNonNegativeNumber(point.fees),
    }));
}

/** Upper bounds of the volume (left) and transaction (right) axes. */
export function computeChartScales(points) {
  const maxVolume = points.reduce((max, point) => Math.max(max, point.volume), MIN_VOLUME_SCALE);
  const maxTxs = points.reduce((max, point) => Math.max(max, point.txCount), MIN_TX_SCALE);
  return { maxVolume: maxVolume * SCALE_HEADROOM, maxTxs: maxTxs * SCALE_HEADROOM };
}

/**
 * Projects normalised points into pixel space for a `width` x `height` plot.
 *
 * Returns `{ points, chartWidth, chartHeight, baselineY, scales }`, or `null`
 * when there is nothing to draw (no points, or the plot area has no room).
 * Each point gains `x`, `volY`, `txY` and `barHeight` (the volume bar's height
 * above the baseline; 0 for zero volume). A single point is centred.
 */
export function projectChartPoints(points, width, height, padding = CHART_PADDING) {
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  if (
    !Array.isArray(points) ||
    points.length === 0 ||
    !Number.isFinite(chartWidth) ||
    !Number.isFinite(chartHeight) ||
    chartWidth <= 0 ||
    chartHeight <= 0
  ) {
    return null;
  }

  const scales = computeChartScales(points);
  const baselineY = padding.top + chartHeight;
  const stepX = points.length > 1 ? chartWidth / (points.length - 1) : 0;
  const startX = points.length > 1 ? padding.left : padding.left + chartWidth / 2;

  const projected = points.map((point, index) => {
    const barHeight = (point.volume / scales.maxVolume) * chartHeight;
    return {
      ...point,
      index,
      x: startX + index * stepX,
      volY: baselineY - barHeight,
      txY: baselineY - (point.txCount / scales.maxTxs) * chartHeight,
      barHeight,
    };
  });

  return { points: projected, chartWidth, chartHeight, baselineY, scales, stepX };
}

/** Index of the point nearest to a horizontal pixel offset, or -1. */
export function nearestPointIndex(x, count, width, padding = CHART_PADDING) {
  const chartWidth = width - padding.left - padding.right;
  if (count <= 0 || !Number.isFinite(x) || chartWidth <= 0) return -1;
  if (x < padding.left || x > width - padding.right) return -1;
  if (count === 1) return 0;
  const stepX = chartWidth / (count - 1);
  return Math.min(Math.max(0, Math.round((x - padding.left) / stepX)), count - 1);
}

const fmt = (value) => {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? '0' : String(rounded);
};

/**
 * SVG path data for a polyline through `points[key]` (e.g. `'volY'`).
 * Returns `''` for no points.
 */
export function buildLinePath(points, key) {
  if (!Array.isArray(points) || points.length === 0) return '';
  return points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${fmt(point.x)} ${fmt(point[key])}`)
    .join(' ');
}

/**
 * Closed SVG path for the area between the volume line and the baseline.
 * Returns `''` for no points.
 */
export function buildAreaPath(points, baselineY) {
  if (!Array.isArray(points) || points.length === 0) return '';
  const first = points[0];
  const last = points[points.length - 1];
  return [
    `M${fmt(first.x)} ${fmt(baselineY)}`,
    ...points.map((point) => `L${fmt(point.x)} ${fmt(point.volY)}`),
    `L${fmt(last.x)} ${fmt(baselineY)}`,
    'Z',
  ].join(' ');
}

/** Aggregate KPIs for the strip above the chart. */
export function computeTotals(points) {
  const totalVolume = points.reduce((sum, point) => sum + point.volume, 0);
  const totalTxs = points.reduce((sum, point) => sum + point.txCount, 0);
  const totalFees = Math.round(points.reduce((sum, point) => sum + point.fees, 0) * 100) / 100;
  const avgTxSize = totalTxs > 0 ? Math.round(totalVolume / totalTxs) : 0;
  return { totalVolume, totalTxs, totalFees, avgTxSize };
}
