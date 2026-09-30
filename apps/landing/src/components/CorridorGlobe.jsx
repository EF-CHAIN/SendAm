import { useEffect, useRef, useState, useId } from 'react';
import { Globe, ArrowRight, Zap, ShieldCheck, Clock, RefreshCw } from 'lucide-react';
import { CORRIDORS } from '@/lib/corridors.js';

// Sample simplified continent dot grid for clean aesthetic globe rendering
const CONTINENT_DOTS = [
  // Africa
  [6.5, 3.4], [9.08, 8.67], [12.0, 8.5], [4.0, 9.7], [0.34, 32.58], [-1.29, 36.82],
  [-4.04, 39.66], [5.6, -0.19], [7.94, -1.02], [14.7, -17.4], [12.37, -1.52],
  [5.35, -4.0], [4.85, -1.75], [0.4, 9.45], [-4.32, 15.31], [-8.83, 13.23],
  [-15.38, 28.32], [-17.82, 31.05], [-26.2, 28.04], [-33.92, 18.42], [-29.85, 31.02],
  [30.04, 31.23], [31.2, 29.9], [33.57, -7.58], [36.75, 3.05], [36.8, 10.18],
  [15.5, 32.53], [9.03, 38.74], [11.58, 43.14], [2.04, 45.34], [-18.9, 47.5],
  [21.0, 10.0], [25.0, 17.0], [17.0, 20.0], [20.0, 30.0], [15.0, 0.0],
  // Europe
  [51.5, -0.12], [53.48, -2.24], [55.95, -3.18], [53.34, -6.26], [48.85, 2.35],
  [50.11, 8.68], [52.52, 13.4], [52.37, 4.9], [50.85, 4.35], [47.37, 8.54],
  [41.9, 12.49], [40.41, -3.7], [38.72, -9.13], [37.98, 23.72], [41.0, 28.97],
  [59.33, 18.06], [59.91, 10.75], [60.16, 24.93], [55.67, 12.56], [52.22, 21.01],
  [50.07, 14.43], [48.2, 16.37], [44.43, 26.1], [46.77, 23.6],
  // North America
  [40.71, -74.0], [42.36, -71.05], [39.95, -75.16], [38.9, -77.03], [33.74, -84.38],
  [25.76, -80.19], [41.87, -87.62], [29.76, -95.36], [32.77, -96.79], [39.73, -104.99],
  [34.05, -118.24], [37.77, -122.41], [47.6, -122.33], [45.51, -122.67], [43.65, -79.38],
  [45.5, -73.56], [49.28, -123.12], [19.43, -99.13], [20.65, -103.34],
  // South America
  [-23.55, -46.63], [-22.9, -43.17], [-15.79, -47.88], [-34.6, -58.38], [-33.44, -70.66],
  [-12.04, -77.04], [4.71, -74.07], [10.48, -66.9], [-0.18, -78.46],
  // Asia & Middle East
  [25.2, 55.27], [24.45, 54.37], [24.71, 46.67], [32.08, 34.78], [35.68, 139.69],
  [37.56, 126.97], [31.23, 121.47], [22.31, 114.16], [1.35, 103.81], [13.75, 100.5],
  [28.61, 77.2], [19.07, 72.87], [12.97, 77.59],
];

// Helper: Convert lat/lng to 3D Cartesian coordinates on unit sphere
function latLngToVector3(lat, lng) {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lng + 180) * (Math.PI / 180);
  const x = -(Math.sin(phi) * Math.cos(theta));
  const z = Math.sin(phi) * Math.sin(theta);
  const y = Math.cos(phi);
  return { x, y, z };
}

// Helper: Rotate vector3 by yaw (around Y axis) and pitch (around X axis)
function rotateVector3(v, yaw, pitch) {
  // Yaw around Y
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);
  const x1 = v.x * cosY + v.z * sinY;
  const y1 = v.y;
  const z1 = -v.x * sinY + v.z * cosY;

  // Pitch around X
  const cosX = Math.cos(pitch);
  const sinX = Math.sin(pitch);
  const x2 = x1;
  const y2 = y1 * cosX - z1 * sinX;
  const z2 = y1 * sinX + z1 * cosX;

  return { x: x2, y: y2, z: z2 };
}

export default function CorridorGlobe() {
  const canvasRef = useRef(null);
  const [selectedCorridor, setSelectedCorridor] = useState(CORRIDORS[0]);
  const [isInteracting, setIsInteracting] = useState(false);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false
  );
  const headingId = useId();

  // Rotation state stored in refs for smooth animation loop
  const stateRef = useRef({
    yaw: 0.2, // Focus towards Atlantic / Africa / Europe by default
    pitch: 0.15,
    targetYaw: 0.2,
    targetPitch: 0.15,
    autoRotate: true,
    lastMouseX: 0,
    lastMouseY: 0,
    isDragging: false,
    dragDistance: 0,
    particles: [
      { corridorIndex: 0, progress: 0.1, speed: 0.006 },
      { corridorIndex: 0, progress: 0.6, speed: 0.006 },
      { corridorIndex: 1, progress: 0.35, speed: 0.0055 },
      { corridorIndex: 1, progress: 0.85, speed: 0.0055 },
      { corridorIndex: 2, progress: 0.2, speed: 0.005 },
      { corridorIndex: 2, progress: 0.7, speed: 0.005 },
      { corridorIndex: 3, progress: 0.45, speed: 0.0062 },
      { corridorIndex: 4, progress: 0.15, speed: 0.0058 },
    ],
  });

  // Check for prefers-reduced-motion changes
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handleChange = (e) => setPrefersReducedMotion(e.matches);
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  // Center globe on selected corridor
  const focusCorridor = (corridor) => {
    setSelectedCorridor(corridor);
    // Calculate midpoint lng/lat between origin and destination
    const midLng = (corridor.from.lng + corridor.to.lng) / 2;
    const midLat = (corridor.from.lat + corridor.to.lat) / 2;

    // Convert to target yaw & pitch
    const targetYaw = -(midLng * (Math.PI / 180));
    const targetPitch = midLat * (Math.PI / 180) * 0.4;

    stateRef.current.targetYaw = targetYaw;
    stateRef.current.targetPitch = targetPitch;
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let ctx = null;
    try {
      ctx = canvas.getContext('2d');
    } catch {
      return;
    }
    if (!ctx) return;

    let animationFrameId;

    const render = () => {
      const state = stateRef.current;
      const width = canvas.width;
      const height = canvas.height;
      const radius = Math.min(width, height) * 0.38;
      const cx = width / 2;
      const cy = height / 2;

      // Update rotation
      if (!state.isDragging) {
        if (state.autoRotate && !prefersReducedMotion) {
          state.targetYaw += 0.0025;
        }
        // Smooth lerp towards target orientation
        state.yaw += (state.targetYaw - state.yaw) * 0.08;
        state.pitch += (state.targetPitch - state.pitch) * 0.08;
      }

      ctx.clearRect(0, 0, width, height);

      // 1. Draw outer atmosphere glow
      const glowGrad = ctx.createRadialGradient(cx, cy, radius * 0.85, cx, cy, radius * 1.25);
      glowGrad.addColorStop(0, 'rgba(13, 148, 136, 0.18)');
      glowGrad.addColorStop(0.5, 'rgba(20, 184, 166, 0.06)');
      glowGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = glowGrad;
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 1.25, 0, Math.PI * 2);
      ctx.fill();

      // 2. Draw globe sphere background
      const sphereGrad = ctx.createRadialGradient(cx - radius * 0.3, cy - radius * 0.3, radius * 0.1, cx, cy, radius);
      sphereGrad.addColorStop(0, '#0f172a');
      sphereGrad.addColorStop(0.7, '#020617');
      sphereGrad.addColorStop(1, '#020617');
      ctx.fillStyle = sphereGrad;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();

      // Sphere border & highlight rim
      ctx.strokeStyle = 'rgba(20, 184, 166, 0.4)';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // 3. Draw grid lines (Latitude & Longitude)
      ctx.lineWidth = 0.75;
      for (let lat = -60; lat <= 60; lat += 30) {
        ctx.beginPath();
        let first = true;
        for (let lng = -180; lng <= 180; lng += 10) {
          const v = latLngToVector3(lat, lng);
          const rv = rotateVector3(v, state.yaw, state.pitch);
          if (rv.z > -0.2) {
            const alpha = Math.max(0, rv.z * 0.25);
            ctx.strokeStyle = `rgba(45, 212, 191, ${alpha})`;
            const px = cx + rv.x * radius;
            const py = cy - rv.y * radius;
            if (first) {
              ctx.moveTo(px, py);
              first = false;
            } else {
              ctx.lineTo(px, py);
            }
          } else {
            first = true;
          }
        }
        ctx.stroke();
      }

      for (let lng = -180; lng <= 180; lng += 30) {
        ctx.beginPath();
        let first = true;
        for (let lat = -80; lat <= 80; lat += 5) {
          const v = latLngToVector3(lat, lng);
          const rv = rotateVector3(v, state.yaw, state.pitch);
          if (rv.z > -0.2) {
            const alpha = Math.max(0, rv.z * 0.25);
            ctx.strokeStyle = `rgba(45, 212, 191, ${alpha})`;
            const px = cx + rv.x * radius;
            const py = cy - rv.y * radius;
            if (first) {
              ctx.moveTo(px, py);
              first = false;
            } else {
              ctx.lineTo(px, py);
            }
          } else {
            first = true;
          }
        }
        ctx.stroke();
      }

      // 4. Draw continent dots
      for (const [dotLat, dotLng] of CONTINENT_DOTS) {
        const v = latLngToVector3(dotLat, dotLng);
        const rv = rotateVector3(v, state.yaw, state.pitch);
        if (rv.z > 0) {
          const px = cx + rv.x * radius;
          const py = cy - rv.y * radius;
          const dotRadius = 2.2 * (0.4 + rv.z * 0.6);
          const alpha = 0.2 + rv.z * 0.6;
          ctx.fillStyle = `rgba(148, 163, 184, ${alpha})`;
          ctx.beginPath();
          ctx.arc(px, py, dotRadius, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // 5. Draw corridor arcs
      CORRIDORS.forEach((corridor, idx) => {
        const isCurrent = corridor.id === selectedCorridor.id;
        const vFrom = latLngToVector3(corridor.from.lat, corridor.from.lng);
        const vTo = latLngToVector3(corridor.to.lat, corridor.to.lng);

        const rvFrom = rotateVector3(vFrom, state.yaw, state.pitch);
        const rvTo = rotateVector3(vTo, state.yaw, state.pitch);

        // Compute 3D midpoint elevated above sphere surface
        const vMid = {
          x: (vFrom.x + vTo.x) * 0.5,
          y: (vFrom.y + vTo.y) * 0.5,
          z: (vFrom.z + vTo.z) * 0.5,
        };
        const midLen = Math.hypot(vMid.x, vMid.y, vMid.z) || 1;
        // Arc elevation factor
        const elevation = 1.28;
        const vPeak = {
          x: (vMid.x / midLen) * elevation,
          y: (vMid.y / midLen) * elevation,
          z: (vMid.z / midLen) * elevation,
        };
        const rvPeak = rotateVector3(vPeak, state.yaw, state.pitch);

        // Draw segmented bezier arc with depth shading
        const segments = 24;
        let prevPx = null;
        let prevPy = null;

        for (let i = 0; i <= segments; i++) {
          const t = i / segments;
          // Quadratic Bezier interpolation in 3D
          const bx = (1 - t) * (1 - t) * rvFrom.x + 2 * (1 - t) * t * rvPeak.x + t * t * rvTo.x;
          const by = (1 - t) * (1 - t) * rvFrom.y + 2 * (1 - t) * t * rvPeak.y + t * t * rvTo.y;
          const bz = (1 - t) * (1 - t) * rvFrom.z + 2 * (1 - t) * t * rvPeak.z + t * t * rvTo.z;

          if (bz > -0.3) {
            const px = cx + bx * radius;
            const py = cy - by * radius;
            const zAlpha = Math.max(0.1, (bz + 0.3) / 1.3);

            if (prevPx !== null) {
              ctx.beginPath();
              ctx.moveTo(prevPx, prevPy);
              ctx.lineTo(px, py);

              if (isCurrent) {
                ctx.strokeStyle = `rgba(52, 211, 153, ${zAlpha * 0.95})`;
                ctx.lineWidth = 2.5;
              } else {
                ctx.strokeStyle = `rgba(20, 184, 166, ${zAlpha * 0.45})`;
                ctx.lineWidth = 1.2;
              }
              ctx.stroke();
            }
            prevPx = px;
            prevPy = py;
          } else {
            prevPx = null;
            prevPy = null;
          }
        }

        // Draw Hub Nodes (Source & Destination)
        [
          { rv: rvFrom, hub: corridor.from, role: 'source' },
          { rv: rvTo, hub: corridor.to, role: 'target' },
        ].forEach(({ rv, hub, role }) => {
          if (rv.z > -0.1) {
            const px = cx + rv.x * radius;
            const py = cy - rv.y * radius;
            const nodeAlpha = Math.max(0.2, rv.z);

            // Pulsing outer halo for active corridor hubs
            if (isCurrent) {
              const time = Date.now() * 0.003;
              const pulse = (Math.sin(time + idx) + 1) * 0.5;
              ctx.beginPath();
              ctx.arc(px, py, 6 + pulse * 6, 0, Math.PI * 2);
              ctx.fillStyle = `rgba(16, 185, 129, ${0.35 * pulse * nodeAlpha})`;
              ctx.fill();
            }

            // Core node dot
            ctx.beginPath();
            ctx.arc(px, py, isCurrent ? 4.5 : 3, 0, Math.PI * 2);
            ctx.fillStyle = isCurrent
              ? role === 'source'
                ? '#38bdf8'
                : '#34d399'
              : `rgba(20, 184, 166, ${nodeAlpha})`;
            ctx.fill();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1;
            ctx.stroke();

            // Label for key hubs when visible
            if (rv.z > 0.4 && isCurrent) {
              ctx.font = '600 11px Inter, sans-serif';
              ctx.fillStyle = '#f8fafc';
              ctx.shadowColor = 'rgba(0,0,0,0.8)';
              ctx.shadowBlur = 4;
              ctx.fillText(`${hub.flag} ${hub.name}`, px + 8, py + 4);
              ctx.shadowBlur = 0;
            }
          }
        });
      });

      // 6. Draw flying payment particles
      if (!prefersReducedMotion) {
        state.particles.forEach((p) => {
          p.progress = (p.progress + p.speed) % 1;
          const corridor = CORRIDORS[p.corridorIndex];
          if (!corridor) return;

          const vFrom = latLngToVector3(corridor.from.lat, corridor.from.lng);
          const vTo = latLngToVector3(corridor.to.lat, corridor.to.lng);
          const vMid = {
            x: (vFrom.x + vTo.x) * 0.5,
            y: (vFrom.y + vTo.y) * 0.5,
            z: (vFrom.z + vTo.z) * 0.5,
          };
          const midLen = Math.hypot(vMid.x, vMid.y, vMid.z) || 1;
          const elevation = 1.28;
          const vPeak = {
            x: (vMid.x / midLen) * elevation,
            y: (vMid.y / midLen) * elevation,
            z: (vMid.z / midLen) * elevation,
          };

          const rvFrom = rotateVector3(vFrom, state.yaw, state.pitch);
          const rvTo = rotateVector3(vTo, state.yaw, state.pitch);
          const rvPeak = rotateVector3(vPeak, state.yaw, state.pitch);

          const t = p.progress;
          const bx = (1 - t) * (1 - t) * rvFrom.x + 2 * (1 - t) * t * rvPeak.x + t * t * rvTo.x;
          const by = (1 - t) * (1 - t) * rvFrom.y + 2 * (1 - t) * t * rvPeak.y + t * t * rvTo.y;
          const bz = (1 - t) * (1 - t) * rvFrom.z + 2 * (1 - t) * t * rvPeak.z + t * t * rvTo.z;

          if (bz > 0) {
            const px = cx + bx * radius;
            const py = cy - by * radius;
            const isCurrent = corridor.id === selectedCorridor.id;

            // Particle glow
            ctx.beginPath();
            ctx.arc(px, py, isCurrent ? 5 : 3.5, 0, Math.PI * 2);
            ctx.fillStyle = isCurrent ? '#a7f3d0' : '#5eead4';
            ctx.shadowColor = '#10b981';
            ctx.shadowBlur = 8;
            ctx.fill();
            ctx.shadowBlur = 0;
          }
        });
      }

      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      if (animationFrameId) cancelAnimationFrame(animationFrameId);
    };
  }, [selectedCorridor, prefersReducedMotion]);

  // Mouse & Touch interaction handlers for interactive drag
  const handlePointerDown = (e) => {
    stateRef.current.isDragging = true;
    stateRef.current.dragDistance = 0;
    stateRef.current.lastMouseX = e.clientX;
    stateRef.current.lastMouseY = e.clientY;
    setIsInteracting(true);
  };

  const handlePointerMove = (e) => {
    if (!stateRef.current.isDragging) return;
    const dx = e.clientX - stateRef.current.lastMouseX;
    const dy = e.clientY - stateRef.current.lastMouseY;
    stateRef.current.dragDistance += Math.abs(dx) + Math.abs(dy);

    stateRef.current.lastMouseX = e.clientX;
    stateRef.current.lastMouseY = e.clientY;

    stateRef.current.yaw += dx * 0.007;
    stateRef.current.targetYaw = stateRef.current.yaw;

    stateRef.current.pitch = Math.max(-0.6, Math.min(0.6, stateRef.current.pitch - dy * 0.007));
    stateRef.current.targetPitch = stateRef.current.pitch;
  };

  const handlePointerUp = () => {
    stateRef.current.isDragging = false;
    setIsInteracting(false);
  };

  return (
    <section
      id="geo-corridors"
      aria-labelledby={headingId}
      className="relative overflow-hidden bg-slate-950 py-20 text-white lg:py-28"
    >
      {/* Background ambient radial glow */}
      <div
        className="pointer-events-none absolute -left-40 top-1/4 h-96 w-96 rounded-full bg-teal-500/10 blur-3xl"
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute -right-40 bottom-1/4 h-96 w-96 rounded-full bg-emerald-500/10 blur-3xl"
        aria-hidden="true"
      />

      <div className="container mx-auto px-4 sm:px-6">
        {/* Header */}
        <div className="mx-auto max-w-3xl text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-teal-500/30 bg-teal-950/60 px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-teal-300">
            <Globe size={14} className="animate-spin-slow text-teal-400" aria-hidden="true" />
            Global Settlement Network
          </div>
          <h2
            id={headingId}
            className="mt-4 text-3xl font-extrabold tracking-tight sm:text-4xl lg:text-5xl"
          >
            Live cross-border <span className="bg-gradient-to-r from-teal-400 to-emerald-400 bg-clip-text text-transparent">corridors</span> on Stellar.
          </h2>
          <p className="mt-4 text-base text-slate-400 sm:text-lg">
            SendAm links remittance epicenters across the UK, US, and EU directly to bank accounts and mobile wallets in Nigeria, Ghana, and Kenya with near-zero latency.
          </p>
        </div>

        {/* Visualizer Layout */}
        <div className="mt-14 grid items-center gap-10 lg:grid-cols-12">
          {/* Globe Canvas Container */}
          <div className="relative flex flex-col items-center justify-center lg:col-span-7">
            <div className="relative aspect-square w-full max-w-[500px] overflow-hidden rounded-3xl border border-slate-800 bg-gradient-to-b from-slate-900/80 to-slate-950/90 p-2 shadow-2xl backdrop-blur-xl">
              <canvas
                ref={canvasRef}
                width={600}
                height={600}
                aria-label="Interactive 3D globe illustrating SendAm remittance corridors connecting UK, USA, EU to Nigeria, Ghana, and Kenya"
                role="img"
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerLeave={handlePointerUp}
                className="h-full w-full cursor-grab touch-none active:cursor-grabbing"
              />

              {/* Interaction Hint Overlay */}
              <div
                className={`pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-slate-700 bg-slate-900/80 px-3.5 py-1 text-xs text-slate-400 shadow-md backdrop-blur-md transition-opacity duration-300 ${
                  isInteracting ? 'opacity-0' : 'opacity-100'
                }`}
              >
                Drag to rotate globe • Click a route below
              </div>
            </div>

            {/* Live Ticker Banner */}
            <div className="mt-4 flex flex-wrap items-center justify-center gap-3 text-xs text-slate-400">
              <span className="inline-flex items-center gap-1.5 rounded-md bg-emerald-950/80 px-2.5 py-1 font-medium text-emerald-400 border border-emerald-800/50">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                Live Stellar network feeds
              </span>
              <span>Average block finality: <strong className="text-slate-200">3.2s</strong></span>
              <span>•</span>
              <span>Protocol fees: <strong className="text-slate-200">&lt;0.2%</strong></span>
            </div>
          </div>

          {/* Corridor Selection & Live Metric Panel */}
          <div className="flex flex-col gap-4 lg:col-span-5">
            <h3 className="text-lg font-bold text-slate-200">
              Active Payment Corridors
            </h3>

            <div
              role="radiogroup"
              aria-label="Select remittance corridor"
              className="flex flex-col gap-3"
            >
              {CORRIDORS.map((corridor) => {
                const isSelected = corridor.id === selectedCorridor.id;
                return (
                  <button
                    key={corridor.id}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    onClick={() => focusCorridor(corridor)}
                    className={`group flex items-center justify-between rounded-2xl border p-4 text-left transition-all ${
                      isSelected
                        ? 'border-teal-500 bg-teal-950/40 shadow-lg shadow-teal-900/20'
                        : 'border-slate-800 bg-slate-900/50 hover:border-slate-700 hover:bg-slate-900'
                    }`}
                  >
                    <div className="flex items-center gap-3.5">
                      <div
                        className={`flex h-10 w-10 items-center justify-center rounded-xl text-lg font-semibold transition-colors ${
                          isSelected ? 'bg-teal-500 text-slate-950' : 'bg-slate-800 text-slate-300 group-hover:bg-slate-700'
                        }`}
                      >
                        {corridor.from.flag}
                      </div>
                      <div>
                        <div className="flex items-center gap-1.5 text-sm font-bold text-white">
                          <span>{corridor.from.name}</span>
                          <ArrowRight size={14} className="text-teal-400" aria-hidden="true" />
                          <span>{corridor.to.flag} {corridor.to.name}</span>
                        </div>
                        <div className="mt-0.5 text-xs text-slate-400">
                          {corridor.pair} • {corridor.rail}
                        </div>
                      </div>
                    </div>

                    <div className="text-right">
                      <div className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-400">
                        <Zap size={12} aria-hidden="true" />
                        {corridor.avgSpeed}
                      </div>
                      <div className="text-[11px] text-slate-400">
                        Fee {corridor.fee}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Selected Corridor Deep-dive Card */}
            <div className="mt-2 rounded-2xl border border-slate-800 bg-gradient-to-br from-slate-900/90 to-slate-950 p-5 shadow-inner">
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <span className="text-xs font-medium uppercase tracking-wider text-slate-400">
                  Corridor Telemetry
                </span>
                <span className="inline-flex items-center gap-1 rounded-full bg-teal-500/10 px-2.5 py-0.5 text-xs font-semibold text-teal-300">
                  <RefreshCw size={11} className="animate-spin-slow" aria-hidden="true" />
                  {selectedCorridor.status}
                </span>
              </div>

              <div className="mt-4 grid grid-cols-3 gap-3 text-center">
                <div className="rounded-xl bg-slate-900/80 p-2.5">
                  <div className="flex items-center justify-center gap-1 text-[11px] text-slate-400">
                    <Clock size={12} className="text-teal-400" aria-hidden="true" />
                    Settlement
                  </div>
                  <div className="mt-1 text-sm font-bold text-white">
                    {selectedCorridor.avgSpeed}
                  </div>
                </div>

                <div className="rounded-xl bg-slate-900/80 p-2.5">
                  <div className="flex items-center justify-center gap-1 text-[11px] text-slate-400">
                    <ShieldCheck size={12} className="text-teal-400" aria-hidden="true" />
                    Protocol Fee
                  </div>
                  <div className="mt-1 text-sm font-bold text-white">
                    {selectedCorridor.fee}
                  </div>
                </div>

                <div className="rounded-xl bg-slate-900/80 p-2.5">
                  <div className="flex items-center justify-center gap-1 text-[11px] text-slate-400">
                    <Zap size={12} className="text-teal-400" aria-hidden="true" />
                    Currency Pair
                  </div>
                  <div className="mt-1 text-xs font-bold text-white">
                    {selectedCorridor.pair}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
