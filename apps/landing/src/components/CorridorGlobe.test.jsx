import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CorridorGlobe from './CorridorGlobe.jsx';
import { CORRIDORS } from '@/lib/corridors.js';

describe('CorridorGlobe', () => {
  beforeEach(() => {
    // Mock canvas context methods in JSDOM environment
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({
      clearRect: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      fillText: vi.fn(),
      createRadialGradient: vi.fn().mockReturnValue({
        addColorStop: vi.fn(),
      }),
      set strokeStyle(val) {},
      set fillStyle(val) {},
      set lineWidth(val) {},
      set shadowColor(val) {},
      set shadowBlur(val) {},
      set font(val) {},
    });
  });

  it('renders the section with heading and canvas', () => {
    render(<CorridorGlobe />);
    expect(screen.getByRole('heading', { level: 2, name: /live cross-border corridors/i })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /interactive 3d globe illustrating sendam remittance corridors/i })).toBeInTheDocument();
  });

  it('renders all active remittance corridors', () => {
    render(<CorridorGlobe />);
    const tabList = screen.getByRole('tablist', { name: /select remittance corridor/i });
    expect(tabList).toBeInTheDocument();

    const options = screen.getAllByRole('tab');
    expect(options).toHaveLength(CORRIDORS.length);
  });

  it('selects a corridor when clicked and updates telemetry info', async () => {
    const user = userEvent.setup();
    render(<CorridorGlobe />);

    const ghanaCorridor = screen.getByRole('tab', { name: /accra/i });
    expect(ghanaCorridor).toHaveAttribute('aria-selected', 'false');

    await user.click(ghanaCorridor);

    expect(ghanaCorridor).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('USD / GHS')).toBeInTheDocument();
  });

  it('supports arrow-key navigation through corridor tabs', async () => {
    const user = userEvent.setup();
    render(<CorridorGlobe />);

    const tabs = screen.getAllByRole('tab');
    tabs[0].focus();
    await user.keyboard('{ArrowDown}');
    expect(tabs[1]).toHaveFocus();
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText(/New York, USA to Accra, GH/)).toHaveAttribute('aria-live', 'polite');
  });

  it('shows the SVG fallback during context loss and resumes the canvas on restore', () => {
    const { container } = render(<CorridorGlobe />);
    const canvas = container.querySelector('canvas');
    const lostEvent = new Event('webglcontextlost', { cancelable: true });

    fireEvent(canvas, lostEvent);
    expect(lostEvent.defaultPrevented).toBe(true);
    expect(screen.getByRole('img', { name: /interactive map of sendam remittance corridors/i })).toBeInTheDocument();

    fireEvent(canvas, new Event('webglcontextrestored'));
    expect(screen.getByRole('img', { name: /interactive 3d globe/i })).toBeInTheDocument();
  });

  it('renders the SVG corridor map when a 2D context is unavailable', () => {
    HTMLCanvasElement.prototype.getContext.mockReturnValue(null);
    render(<CorridorGlobe />);
    expect(screen.getByRole('img', { name: /interactive map of sendam remittance corridors/i })).toBeInTheDocument();
  });

  it('handles pointer drag interactions on the canvas', () => {
    render(<CorridorGlobe />);
    const canvas = screen.getByRole('img', { name: /interactive 3d globe/i });

    fireEvent.pointerDown(canvas, { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(canvas, { clientX: 150, clientY: 120 });
    fireEvent.pointerUp(canvas);
  });

  it('respects prefers-reduced-motion media query', () => {
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    render(<CorridorGlobe />);
    expect(screen.getByRole('img', { name: /interactive 3d globe/i })).toBeInTheDocument();
  });
});
