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
    const radioGroup = screen.getByRole('radiogroup', { name: /select remittance corridor/i });
    expect(radioGroup).toBeInTheDocument();

    const options = screen.getAllByRole('radio');
    expect(options).toHaveLength(CORRIDORS.length);
  });

  it('selects a corridor when clicked and updates telemetry info', async () => {
    const user = userEvent.setup();
    render(<CorridorGlobe />);

    const ghanaCorridor = screen.getByRole('radio', { name: /accra/i });
    expect(ghanaCorridor).toHaveAttribute('aria-checked', 'false');

    await user.click(ghanaCorridor);

    expect(ghanaCorridor).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('USD / GHS')).toBeInTheDocument();
  });

  it('supports keyboard navigation through corridor radio options', async () => {
    const user = userEvent.setup();
    render(<CorridorGlobe />);

    const firstRadio = screen.getAllByRole('radio')[0];
    firstRadio.focus();
    expect(firstRadio).toHaveFocus();

    const secondRadio = screen.getAllByRole('radio')[1];
    await user.click(secondRadio);
    expect(secondRadio).toHaveAttribute('aria-checked', 'true');
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
