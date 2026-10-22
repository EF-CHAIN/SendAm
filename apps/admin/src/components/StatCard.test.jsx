import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Users } from 'lucide-react';
import StatCard from './StatCard';

describe('StatCard', () => {
  it('renders title, value, and icon cleanly without a trend badge when trend is omitted', () => {
    render(<StatCard title="Total Users" value="1,250" icon={Users} colorClass="text-blue-500" />);

    expect(screen.getByText('Total Users')).toBeInTheDocument();
    expect(screen.getByText('1,250')).toBeInTheDocument();
    expect(screen.queryByTestId('trend-badge')).not.toBeInTheDocument();
  });

  it('renders a positive trend badge with green styling, upward icon, and accessible explanation', () => {
    render(
      <StatCard
        title="Settled Volume"
        value="$142,500"
        icon={Users}
        trend={{ value: 12.4, isPositive: true, period: 'vs last week' }}
      />
    );

    const badge = screen.getByTestId('trend-badge');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute('data-direction', 'positive');
    expect(badge).toHaveClass('bg-green-100');
    expect(badge).toHaveClass('text-green-900');
    expect(badge).toHaveAttribute('aria-label', 'Increased by 12.4% vs last week');
    expect(screen.getByText('12.4%')).toBeInTheDocument();
    expect(screen.getByText('vs last week')).toBeInTheDocument();

    const icon = screen.getByTestId('trend-icon');
    expect(icon).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders a negative trend badge with red styling, downward icon, and accessible explanation', () => {
    render(
      <StatCard
        title="Failed Txs"
        value="23"
        icon={Users}
        trend={{ value: 5.2, isPositive: false, period: 'vs yesterday' }}
      />
    );

    const badge = screen.getByTestId('trend-badge');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute('data-direction', 'negative');
    expect(badge).toHaveClass('bg-red-100');
    expect(badge).toHaveClass('text-red-900');
    expect(badge).toHaveAttribute('aria-label', 'Decreased by 5.2% vs yesterday');
    expect(screen.getByText('5.2%')).toBeInTheDocument();
    expect(screen.getByText('vs yesterday')).toBeInTheDocument();
  });

  it('renders a neutral trend badge with gray styling when trend value is 0', () => {
    render(
      <StatCard
        title="Active Operators"
        value="4"
        icon={Users}
        trend={{ value: 0, period: 'vs last week' }}
      />
    );

    const badge = screen.getByTestId('trend-badge');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute('data-direction', 'neutral');
    expect(badge).toHaveClass('bg-gray-100');
    expect(badge).toHaveClass('text-gray-800');
    expect(badge).toHaveAttribute('aria-label', 'Unchanged at 0% vs last week');
    expect(screen.getByText('0%')).toBeInTheDocument();
  });

  it('correctly infers positive and negative direction from numeric shorthand', () => {
    const { rerender } = render(
      <StatCard title="Metric" value="100" icon={Users} trend={8.5} />
    );

    let badge = screen.getByTestId('trend-badge');
    expect(badge).toHaveAttribute('data-direction', 'positive');
    expect(badge).toHaveAttribute('aria-label', 'Increased by 8.5%');
    expect(screen.getByText('8.5%')).toBeInTheDocument();

    rerender(<StatCard title="Metric" value="100" icon={Users} trend={-3.2} />);
    badge = screen.getByTestId('trend-badge');
    expect(badge).toHaveAttribute('data-direction', 'negative');
    expect(badge).toHaveAttribute('aria-label', 'Decreased by 3.2%');
    expect(screen.getByText('3.2%')).toBeInTheDocument();
  });

  it('handles formatted string inputs cleanly without duplicate signs', () => {
    render(
      <StatCard
        title="Metric"
        value="500"
        icon={Users}
        trend={{ value: '+14.5%', isPositive: true, period: 'vs last month' }}
      />
    );

    const badge = screen.getByTestId('trend-badge');
    expect(badge).toHaveAttribute('data-direction', 'positive');
    expect(screen.getByText('14.5%')).toBeInTheDocument();
    expect(badge).toHaveAttribute('aria-label', 'Increased by 14.5% vs last month');
  });

  it('safely handles null, undefined, or empty trend values', () => {
    const { rerender } = render(
      <StatCard title="Metric" value="100" icon={Users} trend={null} />
    );
    expect(screen.queryByTestId('trend-badge')).not.toBeInTheDocument();

    rerender(<StatCard title="Metric" value="100" icon={Users} trend={undefined} />);
    expect(screen.queryByTestId('trend-badge')).not.toBeInTheDocument();

    rerender(<StatCard title="Metric" value="100" icon={Users} trend={{ value: '' }} />);
    expect(screen.queryByTestId('trend-badge')).not.toBeInTheDocument();
  });
});
