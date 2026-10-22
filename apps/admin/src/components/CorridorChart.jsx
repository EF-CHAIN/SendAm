import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { BarChart3 } from 'lucide-react';

import './CorridorChart.css';

const RANGES = {
  '24H': { points: 24, interval: 'hourly' },
  '7D': { points: 7, interval: 'daily' },
  '30D': { points: 30, interval: 'daily' },
  '1Y': { points: 12, interval: 'monthly' },
};

function bucketStart(value, interval) {
  const date = new Date(value);
  if (interval === 'hourly') date.setMinutes(0, 0, 0);
  else {
    date.setHours(0, 0, 0, 0);
    if (interval === 'monthly') date.setDate(1);
  }
  return date;
}

function buckets(range, now) {
  const { points, interval } = RANGES[range];
  return Array.from({ length: points }, (_, index) => {
    const timestamp = bucketStart(now, interval);
    const offset = points - 1 - index;
    if (interval === 'hourly') timestamp.setTime(timestamp.getTime() - offset * 3600000);
    else if (interval === 'monthly') timestamp.setMonth(timestamp.getMonth() - offset);
    else timestamp.setDate(timestamp.getDate() - offset);
    const label = interval === 'hourly'
      ? timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : timestamp.toLocaleDateString([], interval === 'monthly' ? { month: 'short', year: 'numeric' } : { month: 'short', day: 'numeric' });
    return { timestamp, label, volume: 0, txCount: 0, fees: 0 };
  });
}

/** Sample fallback only; supplied empty datasets must never become mock payments. */
// eslint-disable-next-line react-refresh/only-export-components -- helper shared with tests
export function generateSampleCorridorData(range = '7D', corridor = 'ALL', now = Date.now()) {
  const base = corridor === 'NGN' ? 15000 : corridor === 'KES' ? 8000 : corridor === 'GHS' ? 5000 : 28000;
  return buckets(range, now).map((point, index) => {
    const volume = Math.round(base * (1 + Math.sin(index / 3) * 0.3));
    return { ...point, volume, txCount: Math.round(volume / 125), fees: +(volume * 0.0045).toFixed(2), corridor };
  });
}

/** Group supplied history into local calendar buckets, excluding future records. */
// eslint-disable-next-line react-refresh/only-export-components -- helper shared with tests
export function prepareCorridorData(data, range, corridor, now = Date.now()) {
  if (!Array.isArray(data)) return generateSampleCorridorData(range, corridor, now);
  const result = buckets(range, now);
  const byTime = new Map(result.map(point => [+point.timestamp, point]));
  let matched = false;
  for (const point of data) {
    const timestamp = new Date(point.timestamp);
    if (!Number.isFinite(+timestamp) || +timestamp > +now || (corridor !== 'ALL' && point.corridor !== corridor)) continue;
    const bucket = byTime.get(+bucketStart(timestamp, RANGES[range].interval));
    if (!bucket) continue;
    matched = true;
    for (const key of ['volume', 'txCount', 'fees']) {
      const value = Number(point[key]);
      if (Number.isFinite(value)) bucket[key] += value;
    }
  }
  return matched ? result : [];
}

/**
 * High-performance Financial Canvas Chart Suite for Volume, Fees, and Corridor Analytics.
 * Closes #586.
 */
export default function CorridorChart({ data: propData, loading = false, title = 'Corridor Volume & Fee Analytics' }) {
  const [range, setRange] = useState('7D');
  const [selectedCorridor, setSelectedCorridor] = useState('ALL'); // 'ALL' | 'NGN' | 'KES' | 'GHS'
  const [hoveredPoint, setHoveredPoint] = useState(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0, active: false });

  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const animationFrameRef = useRef(null);

  const [dataset, setDataset] = useState(() => ({
    source: propData, range: '7D', corridor: 'ALL',
    points: prepareCorridorData(propData, '7D', 'ALL'),
  }));
  const isLoading = loading || dataset.source !== propData || dataset.range !== range || dataset.corridor !== selectedCorridor;
  const chartData = dataset.points;

  // Give the skeleton a paint before preparing the next dataset. Cleanup prevents
  // a superseded selection (or an unmounted chart) from committing stale results.
  useEffect(() => {
    if (!isLoading || loading) return;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        setHoveredPoint(null);
        setMousePos({ x: 0, y: 0, active: false });
        setDataset({ source: propData, range, corridor: selectedCorridor, points: prepareCorridorData(propData, range, selectedCorridor) });
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [propData, range, selectedCorridor, isLoading, loading]);

  const selectRange = (next) => {
    setHoveredPoint(null);
    setMousePos({ x: 0, y: 0, active: false });
    setRange(next);
  };
  const selectCorridor = (next) => {
    setHoveredPoint(null);
    setMousePos({ x: 0, y: 0, active: false });
    setSelectedCorridor(next);
  };

  // Aggregate metrics
  const totals = useMemo(() => {
    const totalVolume = chartData.reduce((sum, d) => sum + (d.volume || 0), 0);
    const totalTxs = chartData.reduce((sum, d) => sum + (d.txCount || 0), 0);
    const totalFees = chartData.reduce((sum, d) => sum + (d.fees || 0), 0);
    const avgTxSize = totalTxs > 0 ? Math.round(totalVolume / totalTxs) : 0;
    return { totalVolume, totalTxs, totalFees, avgTxSize };
  }, [chartData]);

  // Canvas drawing routine
  const drawChart = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;

    // Adjust canvas dimensions for retina display
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const padding = { top: 30, right: 60, bottom: 40, left: 65 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    if (chartWidth <= 0 || chartHeight <= 0 || chartData.length === 0) {
      ctx.restore();
      return;
    }

    // Min & Max calculations
    const maxVolume = Math.max(...chartData.map((d) => d.volume), 1000) * 1.15;
    const maxTxs = Math.max(...chartData.map((d) => d.txCount), 10) * 1.15;

    // Draw Grid Lines (Horizontal)
    const gridLines = 5;
    ctx.strokeStyle = '#f1f5f9';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#94a3b8';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'right';

    for (let i = 0; i <= gridLines; i++) {
      const y = padding.top + (chartHeight / gridLines) * i;
      const volVal = maxVolume - (maxVolume / gridLines) * i;
      const txVal = maxTxs - (maxTxs / gridLines) * i;

      // Line
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();

      // Left Y-axis Label (Volume USD)
      ctx.textAlign = 'right';
      ctx.fillStyle = '#64748b';
      ctx.fillText(`$${Math.round(volVal).toLocaleString()}`, padding.left - 10, y + 4);

      // Right Y-axis Label (Tx Count)
      ctx.textAlign = 'left';
      ctx.fillStyle = '#8b5cf6';
      ctx.fillText(`${Math.round(txVal)} txs`, width - padding.right + 10, y + 4);
    }

    // Calculate X coordinate for each data point
    const stepX = chartWidth / (chartData.length - 1 || 1);
    const points = chartData.map((d, index) => {
      const x = padding.left + index * stepX;
      const volY = padding.top + chartHeight - (d.volume / maxVolume) * chartHeight;
      const txY = padding.top + chartHeight - (d.txCount / maxTxs) * chartHeight;
      return { ...d, x, volY, txY, index };
    });

    // 1. Draw Volume Area Gradient
    const gradient = ctx.createLinearGradient(0, padding.top, 0, height - padding.bottom);
    gradient.addColorStop(0, 'rgba(59, 130, 246, 0.25)');
    gradient.addColorStop(1, 'rgba(59, 130, 246, 0.00)');

    ctx.beginPath();
    ctx.moveTo(points[0].x, height - padding.bottom);
    points.forEach((p) => ctx.lineTo(p.x, p.volY));
    ctx.lineTo(points[points.length - 1].x, height - padding.bottom);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    // 2. Draw Volume Line (Blue)
    ctx.beginPath();
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    points.forEach((p, idx) => {
      if (idx === 0) ctx.moveTo(p.x, p.volY);
      else ctx.lineTo(p.x, p.volY);
    });
    ctx.stroke();

    // 3. Draw Tx Count Line (Purple Dashed)
    ctx.beginPath();
    ctx.strokeStyle = '#8b5cf6';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    points.forEach((p, idx) => {
      if (idx === 0) ctx.moveTo(p.x, p.txY);
      else ctx.lineTo(p.x, p.txY);
    });
    ctx.stroke();
    ctx.setLineDash([]); // Reset dash

    // 4. Draw X-Axis Labels (every Nth point to prevent overlap)
    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'center';
    const labelFrequency = Math.ceil(chartData.length / 7);
    points.forEach((p, idx) => {
      if (idx % labelFrequency === 0 || idx === points.length - 1) {
        ctx.fillText(p.label, p.x, height - padding.bottom + 20);
      }
    });

    // 5. Crosshair Cursor & Highlights
    if (mousePos.active && hoveredPoint) {
      // Vertical crosshair line
      ctx.beginPath();
      ctx.strokeStyle = '#cbd5e1';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.moveTo(hoveredPoint.x, padding.top);
      ctx.lineTo(hoveredPoint.x, height - padding.bottom);
      ctx.stroke();
      ctx.setLineDash([]);

      // Highlight point for Volume
      ctx.beginPath();
      ctx.arc(hoveredPoint.x, hoveredPoint.volY, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#2563eb';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();

      // Highlight point for Tx Count
      ctx.beginPath();
      ctx.arc(hoveredPoint.x, hoveredPoint.txY, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = '#8b5cf6';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
    }

    ctx.restore();
  }, [chartData, mousePos, hoveredPoint]);

  // Handle Mouse / Touch interactions
  const handleMouseMove = (e) => {
    if (isLoading || chartData.length === 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const clientX = e.clientX ?? e.touches?.[0]?.clientX;
    const clientY = e.clientY ?? e.touches?.[0]?.clientY;

    if (clientX === undefined) return;

    const x = clientX - rect.left;
    const y = clientY - rect.top;

    const paddingLeft = 65;
    const paddingRight = 60;
    const chartWidth = canvas.clientWidth - paddingLeft - paddingRight;

    if (x >= paddingLeft && x <= canvas.clientWidth - paddingRight) {
      const stepX = chartWidth / (chartData.length - 1 || 1);
      const index = Math.min(
        Math.max(0, Math.round((x - paddingLeft) / stepX)),
        chartData.length - 1
      );
      const point = chartData[index];
      setHoveredPoint({
        ...point,
        x: paddingLeft + index * stepX,
        screenX: x,
        screenY: y,
        canvasWidth: canvas.clientWidth,
      });
      setMousePos({ x, y, active: true });
    } else {
      setMousePos({ x: 0, y: 0, active: false });
      setHoveredPoint(null);
    }
  };

  const handleMouseLeave = () => {
    setMousePos({ x: 0, y: 0, active: false });
    setHoveredPoint(null);
  };

  // ResizeObserver for zero-layout-shift and 60fps responsiveness
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let resizeObserver = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = requestAnimationFrame(drawChart);
      });
      resizeObserver.observe(canvas);
    }

    drawChart();

    return () => {
      if (resizeObserver) resizeObserver.disconnect();
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    };
  }, [drawChart]);

  return (
    <div
      ref={containerRef}
      className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 sm:p-6 space-y-6"
    >
      {/* Header & Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-indigo-600" />
            <h2 className="text-lg font-bold text-gray-900">{title}</h2>
          </div>
          <p className="text-xs text-gray-500 mt-0.5">
            Real-time dual-axis time-series: USD Settled Volume vs. Transaction Throughput
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Corridor selector buttons */}
          <div className="flex items-center bg-gray-100 p-1 rounded-xl text-xs font-semibold">
            {['ALL', 'NGN', 'KES', 'GHS'].map((corridor) => (
              <button
                key={corridor}
                type="button"
                onClick={() => selectCorridor(corridor)}
                aria-pressed={selectedCorridor === corridor}
                className={`px-3 py-1 rounded-lg transition-all ${
                  selectedCorridor === corridor
                    ? 'bg-white text-gray-900 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
                aria-label={`Filter corridor ${corridor}`}
              >
                {corridor === 'ALL' ? 'All Corridors' : corridor}
              </button>
            ))}
          </div>

          {/* Timeframe selector */}
          <div role="group" aria-label="Chart time range" className="flex items-center bg-gray-100 p-1 rounded-xl text-xs font-semibold">
            {Object.keys(RANGES).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => selectRange(option)}
                aria-pressed={range === option}
                className={`px-2.5 py-1 capitalize rounded-lg transition-all ${
                  range === option
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
                aria-label={`Show ${option} time range`}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Aggregate KPI Strip */}
      <div aria-busy={isLoading} className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-gray-50/80 p-3.5 rounded-xl border border-gray-100 text-xs">
        <div>
          <span className="text-gray-500 font-medium block">Total Volume</span>
          <span className="text-sm sm:text-base font-bold text-gray-900">
            {isLoading ? '\u2014' : `$${totals.totalVolume.toLocaleString()}`}
          </span>
        </div>
        <div>
          <span className="text-gray-500 font-medium block">Total Transactions</span>
          <span className="text-sm sm:text-base font-bold text-purple-700">
            {isLoading ? '\u2014' : `${totals.totalTxs.toLocaleString()} txs`}
          </span>
        </div>
        <div>
          <span className="text-gray-500 font-medium block">Est. Revenue / Fees</span>
          <span className="text-sm sm:text-base font-bold text-emerald-600">
            {isLoading ? '\u2014' : `$${totals.totalFees.toLocaleString()}`}
          </span>
        </div>
        <div>
          <span className="text-gray-500 font-medium block">Average Ticket Size</span>
          <span className="text-sm sm:text-base font-bold text-indigo-600">
            {isLoading ? '\u2014' : `$${totals.avgTxSize.toLocaleString()}`}
          </span>
        </div>
      </div>

      {/* Canvas Area Container */}
      <div className="relative w-full h-[320px] select-none" aria-busy={isLoading} aria-label="Corridor chart">
        <canvas
          ref={canvasRef}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          onTouchMove={handleMouseMove}
          onTouchEnd={handleMouseLeave}
          className={`w-full h-full cursor-crosshair block ${isLoading ? 'invisible' : ''}`}
          aria-hidden={isLoading}
          aria-label="Interactive Canvas Financial Chart"
        />

        {isLoading && (
          <div role="status" className="absolute inset-0 overflow-hidden rounded-xl bg-slate-50 corridor-chart-skeleton">
            <span className="sr-only">Loading {range} corridor chart</span>
            <div aria-hidden="true" className="absolute inset-x-8 inset-y-8 flex items-end gap-3 border-b border-l border-slate-200 p-4">
              {[35, 55, 45, 75, 60, 85, 65].map((height, index) => <div key={index} className="flex-1 rounded-t bg-slate-200/70" style={{ height: `${height}%` }} />)}
            </div>
          </div>
        )}
        {!isLoading && chartData.length === 0 && <p className="absolute inset-0 flex items-center justify-center text-sm text-gray-500" role="status">No payments in this time range.</p>}
        {/* Floating Tooltip */}
        {!isLoading && hoveredPoint && (
          <div
            className="absolute z-10 pointer-events-none bg-gray-900/90 backdrop-blur-md text-white px-3 py-2.5 rounded-xl text-xs shadow-xl border border-gray-800 transition-transform duration-75 min-w-[160px]"
            style={{
              left: `${Math.min(Math.max(hoveredPoint.screenX - 80, 10), hoveredPoint.canvasWidth - 170 || 200)}px`,
              top: '20px',
            }}
          >
            <div className="font-semibold text-gray-300 pb-1 mb-1.5 border-b border-gray-700 flex justify-between">
              <span>{hoveredPoint.label}</span>
              <span className="text-indigo-400 font-mono">{hoveredPoint.corridor || selectedCorridor}</span>
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-3">
                <span className="text-blue-400 flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-blue-500 inline-block" />
                  Volume:
                </span>
                <span className="font-bold font-mono">${hoveredPoint.volume.toLocaleString()}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-purple-400 flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-purple-500 inline-block" />
                  Tx Count:
                </span>
                <span className="font-bold font-mono">{hoveredPoint.txCount} txs</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-emerald-400 flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" />
                  Fees (0.45%):
                </span>
                <span className="font-bold font-mono">${hoveredPoint.fees}</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Chart Legend */}
      <div className="flex items-center justify-center gap-6 pt-2 border-t border-gray-100 text-xs font-medium text-gray-600">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-sm bg-blue-600" />
          <span>Settled Volume (USD Equivalent)</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-1 border-t-2 border-dashed border-purple-500" />
          <span>Transaction Throughput (Count)</span>
        </div>
      </div>
    </div>
  );
}
