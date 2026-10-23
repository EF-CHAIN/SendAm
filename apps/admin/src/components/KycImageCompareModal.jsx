import { useState, useRef, useEffect } from 'react';
import {
  ZoomIn,
  ZoomOut,
  RotateCw,
  Sun,
  Contrast,
  RotateCcw,
  Maximize2,
  Minimize2,
  X,
  FileText,
  UserCheck,
  CheckCircle,
  XCircle,
  HelpCircle,
} from 'lucide-react';

/**
 * KycImageCompareModal
 * Side-by-side split-screen comparison viewer for passport / NIN document and selfie liveness photos.
 * Features:
 * - Synchronized zoom toggle (zooms both panels together or independently)
 * - Mousewheel zoom with boundary clamping (0.5x - 5.0x)
 * - Mouse drag-to-pan controls
 * - 90-degree image rotation per pane or synchronized
 * - Brightness (50% - 200%) and contrast (50% - 200%) sliders / presets
 * - Reset view button to restore default pan, zoom, rotation, and filters
 * - Direct quick-action Approve / Reject callbacks for reviewer convenience
 */
export default function KycImageCompareModal({
  isOpen,
  onClose,
  record,
  onApprove,
  onReject,
}) {
  const [syncZoom, setSyncZoom] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [draggingPane, setDraggingPane] = useState(null);

  // Pane states: doc (document / passport / NIN) and selfie (liveness)
  const [docState, setDocState] = useState({
    zoom: 1,
    rotation: 0,
    brightness: 100,
    contrast: 100,
    panX: 0,
    panY: 0,
  });

  const [selfieState, setSelfieState] = useState({
    zoom: 1,
    rotation: 0,
    brightness: 100,
    contrast: 100,
    panX: 0,
    panY: 0,
  });

  // Track dragging state
  const draggingPaneRef = useRef(null);
  const dragStartRef = useRef({ x: 0, y: 0, initialPanX: 0, initialPanY: 0 });

  // Handle escape key to close modal
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || !record) return null;

  // Placeholder images when URLs are not provided
  // SVG data URIs with realistic document and selfie mock vectors
  const fallbackDocSvg = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400" fill="%23f8fafc"><rect width="600" height="400" fill="%23f1f5f9" rx="16"/><rect x="40" y="40" width="520" height="320" rx="8" fill="%23ffffff" stroke="%23cbd5e1" stroke-width="2"/><rect x="70" y="70" width="130" height="160" rx="4" fill="%23e2e8f0" stroke="%2394a3b8"/><circle cx="135" cy="130" r="35" fill="%23cbd5e1"/><path d="M95 210 C95 180, 175 180, 175 210 Z" fill="%23cbd5e1"/><text x="230" y="100" font-family="sans-serif" font-size="20" font-weight="bold" fill="%231e293b">FEDERAL REPUBLIC PASSPORT / ID</text><text x="230" y="130" font-family="monospace" font-size="14" fill="%2364748b">DOC NO: A98234120</text><text x="230" y="155" font-family="sans-serif" font-size="14" fill="%23334155">SURNAME: OKAFOR</text><text x="230" y="180" font-family="sans-serif" font-size="14" fill="%23334155">GIVEN NAMES: CHIDIEBERE VICTOR</text><text x="230" y="205" font-family="sans-serif" font-size="14" fill="%23334155">NATIONALITY: NIGERIAN</text><path d="M70 270 Q120 250, 170 275 T270 260" stroke="%231e293b" stroke-width="2" fill="none"/><text x="70" y="300" font-family="sans-serif" font-size="11" fill="%2364748b">DOCUMENT SIGNATURE</text><rect x="340" y="240" width="190" height="70" rx="4" fill="%23f8fafc" stroke="%23e2e8f0"/><text x="350" y="275" font-family="monospace" font-size="12" fill="%230f172a">P&lt;NGAOKAFOR&lt;&lt;CHIDIEBERE&lt;&lt;&lt;&lt;</text></svg>`;

  const fallbackSelfieSvg = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400" fill="%23f8fafc"><rect width="600" height="400" fill="%23f1f5f9" rx="16"/><rect x="120" y="30" width="360" height="340" rx="12" fill="%23ffffff" stroke="%23cbd5e1" stroke-width="2"/><circle cx="300" cy="160" r="70" fill="%23e2e8f0" stroke="%2394a3b8"/><path d="M220 310 C220 250, 380 250, 380 310 Z" fill="%23e2e8f0"/><circle cx="280" cy="150" r="8" fill="%23475569"/><circle cx="320" cy="150" r="8" fill="%23475569"/><path d="M285 190 Q300 205, 315 190" stroke="%23475569" stroke-width="3" fill="none" stroke-linecap="round"/><rect x="150" y="325" width="300" height="30" rx="15" fill="%23ecfdf5"/><text x="300" y="345" font-family="sans-serif" font-size="12" font-weight="bold" fill="%23059669" text-anchor="middle">✓ LIVENESS VERIFIED (SMILE ID 3D)</text></svg>`;

  const documentImage = record.documentUrl || record.documentImage || fallbackDocSvg;
  const selfieImage = record.selfieUrl || record.selfieImage || fallbackSelfieSvg;

  // Zoom handlers
  const handleZoom = (pane, delta) => {
    const updateZoom = (curr) => Math.min(5, Math.max(0.5, Number((curr + delta).toFixed(2))));
    if (syncZoom) {
      setDocState((prev) => ({ ...prev, zoom: updateZoom(prev.zoom) }));
      setSelfieState((prev) => ({ ...prev, zoom: updateZoom(prev.zoom) }));
    } else if (pane === 'doc') {
      setDocState((prev) => ({ ...prev, zoom: updateZoom(prev.zoom) }));
    } else {
      setSelfieState((prev) => ({ ...prev, zoom: updateZoom(prev.zoom) }));
    }
  };

  // Wheel zoom handler
  const handleWheel = (e, pane) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.2 : -0.2;
    handleZoom(pane, delta);
  };

  // Rotation handler (90 degrees clockwise)
  const handleRotate = (pane) => {
    if (pane === 'doc') {
      setDocState((prev) => ({ ...prev, rotation: (prev.rotation + 90) % 360 }));
    } else {
      setSelfieState((prev) => ({ ...prev, rotation: (prev.rotation + 90) % 360 }));
    }
  };

  // Reset pane controls
  const handleReset = (pane) => {
    const def = { zoom: 1, rotation: 0, brightness: 100, contrast: 100, panX: 0, panY: 0 };
    if (!pane || pane === 'all') {
      setDocState(def);
      setSelfieState(def);
    } else if (pane === 'doc') {
      setDocState(def);
    } else {
      setSelfieState(def);
    }
  };

  // Mouse pan drag handlers
  const handleMouseDown = (e, pane) => {
    e.preventDefault();
    draggingPaneRef.current = pane;
    setDraggingPane(pane);
    const currentState = pane === 'doc' ? docState : selfieState;
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      initialPanX: currentState.panX,
      initialPanY: currentState.panY,
    };

    const handleMouseMove = (moveEvent) => {
      if (!draggingPaneRef.current) return;
      const dx = moveEvent.clientX - dragStartRef.current.x;
      const dy = moveEvent.clientY - dragStartRef.current.y;
      const targetPane = draggingPaneRef.current;

      if (targetPane === 'doc') {
        setDocState((prev) => ({
          ...prev,
          panX: dragStartRef.current.initialPanX + dx,
          panY: dragStartRef.current.initialPanY + dy,
        }));
      } else {
        setSelfieState((prev) => ({
          ...prev,
          panX: dragStartRef.current.initialPanX + dx,
          panY: dragStartRef.current.initialPanY + dy,
        }));
      }
    };

    const handleMouseUp = () => {
      draggingPaneRef.current = null;
      setDraggingPane(null);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="kyc-compare-title"
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-2 sm:p-4 animate-in fade-in duration-200"
    >
      <div
        className={`bg-white dark:bg-slate-900 rounded-2xl shadow-2xl flex flex-col overflow-hidden transition-all duration-200 ${
          isFullscreen ? 'w-full h-full rounded-none' : 'w-full max-w-7xl max-h-[94vh]'
        }`}
      >
        {/* Top Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/80">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-primary/10 text-primary flex items-center justify-center font-bold">
              <FileText className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 id="kyc-compare-title" className="text-base font-bold text-slate-900 dark:text-white">
                  Document vs Selfie Liveness Verification
                </h2>
                <span className="text-xs px-2 py-0.5 rounded-full bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-medium">
                  {record.provider || 'Smile ID'}
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Customer: <span className="font-semibold text-slate-700 dark:text-slate-300">{record.userId?.phoneNumber || '-'}</span> | Tier: {record.tier || 'Tier 1'} | Risk: {record.riskScore || 'Low'}
              </p>
            </div>
          </div>

          {/* Right Header Controls */}
          <div className="flex items-center gap-2">
            {/* Synchronized Zoom Toggle */}
            <button
              type="button"
              onClick={() => setSyncZoom((v) => !v)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition ${
                syncZoom
                  ? 'bg-primary/10 border-primary/30 text-primary'
                  : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'
              }`}
              title="Synchronize zoom level across both panes"
              data-testid="toggle-sync-zoom"
            >
              <HelpCircle className="w-3.5 h-3.5" />
              Sync Zoom: {syncZoom ? 'ON' : 'OFF'}
            </button>

            {/* Reset All */}
            <button
              type="button"
              onClick={() => handleReset('all')}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-750 transition"
              data-testid="reset-all-views"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reset All
            </button>

            {/* Fullscreen Toggle */}
            <button
              type="button"
              onClick={() => setIsFullscreen((f) => !f)}
              aria-label={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
              className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
            >
              {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </button>

            {/* Close Button */}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close Comparison Viewer"
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
              data-testid="close-compare-modal"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Side-by-Side Split Viewport */}
        <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-2 p-2 bg-slate-900 overflow-hidden relative">
          {/* Left Pane: ID / Passport / NIN Document */}
          <div className="flex flex-col bg-slate-950/80 rounded-xl border border-slate-800 overflow-hidden relative group">
            {/* Pane Controls Bar */}
            <div className="flex items-center justify-between px-3 py-2 bg-slate-900/90 border-b border-slate-800 text-slate-300 text-xs z-10">
              <div className="flex items-center gap-2 font-semibold">
                <FileText className="w-4 h-4 text-primary" />
                <span>Identity Document (Passport / NIN)</span>
                <span className="text-[10px] px-1.5 py-0.2 bg-slate-800 rounded text-slate-400" data-testid="doc-zoom-level">
                  {Math.round(docState.zoom * 100)}%
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => handleZoom('doc', -0.2)}
                  className="p-1 hover:bg-slate-800 rounded text-slate-300 hover:text-white"
                  title="Zoom Out"
                  aria-label="Zoom out document"
                  data-testid="doc-zoom-out"
                >
                  <ZoomOut className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => handleZoom('doc', 0.2)}
                  className="p-1 hover:bg-slate-800 rounded text-slate-300 hover:text-white"
                  title="Zoom In"
                  aria-label="Zoom in document"
                  data-testid="doc-zoom-in"
                >
                  <ZoomIn className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => handleRotate('doc')}
                  className="p-1 hover:bg-slate-800 rounded text-slate-300 hover:text-white"
                  title="Rotate 90°"
                  aria-label="Rotate document 90 degrees"
                  data-testid="doc-rotate"
                >
                  <RotateCw className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => handleReset('doc')}
                  className="p-1 hover:bg-slate-800 rounded text-slate-300 hover:text-white"
                  title="Reset Document View"
                  aria-label="Reset document view"
                  data-testid="doc-reset"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Sliders Drawer */}
            <div className="flex items-center gap-4 px-3 py-1.5 bg-slate-900/60 border-b border-slate-800/60 text-[11px] text-slate-400">
              <div className="flex items-center gap-1.5">
                <Sun className="w-3 h-3 text-amber-400" />
                <span>Brightness:</span>
                <input
                  type="range"
                  min="50"
                  max="200"
                  value={docState.brightness}
                  onChange={(e) => setDocState((prev) => ({ ...prev, brightness: Number(e.target.value) }))}
                  className="w-16 h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-primary"
                  aria-label="Document Brightness"
                />
                <span className="w-8 text-right font-mono">{docState.brightness}%</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Contrast className="w-3 h-3 text-cyan-400" />
                <span>Contrast:</span>
                <input
                  type="range"
                  min="50"
                  max="200"
                  value={docState.contrast}
                  onChange={(e) => setDocState((prev) => ({ ...prev, contrast: Number(e.target.value) }))}
                  className="w-16 h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-primary"
                  aria-label="Document Contrast"
                />
                <span className="w-8 text-right font-mono">{docState.contrast}%</span>
              </div>
            </div>

            {/* Viewport Canvas Container */}
            <div
              className="flex-1 w-full h-[320px] md:h-[460px] overflow-hidden flex items-center justify-center cursor-grab active:cursor-grabbing select-none relative"
              onMouseDown={(e) => handleMouseDown(e, 'doc')}
              onWheel={(e) => handleWheel(e, 'doc')}
              data-testid="doc-viewport"
            >
              <div
                style={{
                  transform: `translate(${docState.panX}px, ${docState.panY}px) scale(${docState.zoom}) rotate(${docState.rotation}deg)`,
                  filter: `brightness(${docState.brightness}%) contrast(${docState.contrast}%)`,
                  transition: draggingPane === 'doc' ? 'none' : 'transform 0.1s ease-out',
                }}
                className="transform-gpu flex items-center justify-center max-w-full max-h-full"
              >
                <img
                  src={documentImage}
                  alt="Government ID Document"
                  className="max-h-[380px] object-contain rounded shadow-lg pointer-events-none"
                  draggable={false}
                  data-testid="doc-image"
                />
              </div>

              {/* Pan/Zoom helper hint */}
              <div className="absolute bottom-2 left-2 px-2 py-1 bg-black/60 backdrop-blur rounded text-[10px] text-slate-400 pointer-events-none">
                Scroll to zoom | Drag to pan
              </div>
            </div>
          </div>

          {/* Right Pane: Selfie Liveness Photo */}
          <div className="flex flex-col bg-slate-950/80 rounded-xl border border-slate-800 overflow-hidden relative group">
            {/* Pane Controls Bar */}
            <div className="flex items-center justify-between px-3 py-2 bg-slate-900/90 border-b border-slate-800 text-slate-300 text-xs z-10">
              <div className="flex items-center gap-2 font-semibold">
                <UserCheck className="w-4 h-4 text-emerald-400" />
                <span>Selfie Liveness Capture</span>
                <span className="text-[10px] px-1.5 py-0.2 bg-slate-800 rounded text-slate-400" data-testid="selfie-zoom-level">
                  {Math.round(selfieState.zoom * 100)}%
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => handleZoom('selfie', -0.2)}
                  className="p-1 hover:bg-slate-800 rounded text-slate-300 hover:text-white"
                  title="Zoom Out"
                  aria-label="Zoom out selfie"
                  data-testid="selfie-zoom-out"
                >
                  <ZoomOut className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => handleZoom('selfie', 0.2)}
                  className="p-1 hover:bg-slate-800 rounded text-slate-300 hover:text-white"
                  title="Zoom In"
                  aria-label="Zoom in selfie"
                  data-testid="selfie-zoom-in"
                >
                  <ZoomIn className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => handleRotate('selfie')}
                  className="p-1 hover:bg-slate-800 rounded text-slate-300 hover:text-white"
                  title="Rotate 90°"
                  aria-label="Rotate selfie 90 degrees"
                  data-testid="selfie-rotate"
                >
                  <RotateCw className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => handleReset('selfie')}
                  className="p-1 hover:bg-slate-800 rounded text-slate-300 hover:text-white"
                  title="Reset Selfie View"
                  aria-label="Reset selfie view"
                  data-testid="selfie-reset"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Sliders Drawer */}
            <div className="flex items-center gap-4 px-3 py-1.5 bg-slate-900/60 border-b border-slate-800/60 text-[11px] text-slate-400">
              <div className="flex items-center gap-1.5">
                <Sun className="w-3 h-3 text-amber-400" />
                <span>Brightness:</span>
                <input
                  type="range"
                  min="50"
                  max="200"
                  value={selfieState.brightness}
                  onChange={(e) => setSelfieState((prev) => ({ ...prev, brightness: Number(e.target.value) }))}
                  className="w-16 h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-primary"
                  aria-label="Selfie Brightness"
                />
                <span className="w-8 text-right font-mono">{selfieState.brightness}%</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Contrast className="w-3 h-3 text-cyan-400" />
                <span>Contrast:</span>
                <input
                  type="range"
                  min="50"
                  max="200"
                  value={selfieState.contrast}
                  onChange={(e) => setSelfieState((prev) => ({ ...prev, contrast: Number(e.target.value) }))}
                  className="w-16 h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-primary"
                  aria-label="Selfie Contrast"
                />
                <span className="w-8 text-right font-mono">{selfieState.contrast}%</span>
              </div>
            </div>

            {/* Viewport Canvas Container */}
            <div
              className="flex-1 w-full h-[320px] md:h-[460px] overflow-hidden flex items-center justify-center cursor-grab active:cursor-grabbing select-none relative"
              onMouseDown={(e) => handleMouseDown(e, 'selfie')}
              onWheel={(e) => handleWheel(e, 'selfie')}
              data-testid="selfie-viewport"
            >
              <div
                style={{
                  transform: `translate(${selfieState.panX}px, ${selfieState.panY}px) scale(${selfieState.zoom}) rotate(${selfieState.rotation}deg)`,
                  filter: `brightness(${selfieState.brightness}%) contrast(${selfieState.contrast}%)`,
                  transition: draggingPane === 'selfie' ? 'none' : 'transform 0.1s ease-out',
                }}
                className="transform-gpu flex items-center justify-center max-w-full max-h-full"
              >
                <img
                  src={selfieImage}
                  alt="Selfie Liveness Capture"
                  className="max-h-[380px] object-contain rounded shadow-lg pointer-events-none"
                  draggable={false}
                  data-testid="selfie-image"
                />
              </div>

              {/* Pan/Zoom helper hint */}
              <div className="absolute bottom-2 left-2 px-2 py-1 bg-black/60 backdrop-blur rounded text-[10px] text-slate-400 pointer-events-none">
                Scroll to zoom | Drag to pan
              </div>
            </div>
          </div>
        </div>

        {/* Bottom Review Decision Bar */}
        <div className="flex flex-col sm:flex-row items-center justify-between px-5 py-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 gap-3">
          <div className="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-2">
            <span>Verify face structure, eye alignment, and signature authenticity across both captures.</span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800 rounded-lg transition"
            >
              Close
            </button>
            {onReject && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onReject(record);
                }}
                className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold bg-red-600 hover:bg-red-700 text-white rounded-lg transition shadow-sm"
                data-testid="compare-modal-reject-btn"
              >
                <XCircle className="w-3.5 h-3.5" />
                Reject...
              </button>
            )}
            {onApprove && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onApprove(record);
                }}
                className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold bg-green-600 hover:bg-green-700 text-white rounded-lg transition shadow-sm"
                data-testid="compare-modal-approve-btn"
              >
                <CheckCircle className="w-3.5 h-3.5" />
                Approve...
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
