import { describe, it, expect, vi, beforeEach } from 'vitest';
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
