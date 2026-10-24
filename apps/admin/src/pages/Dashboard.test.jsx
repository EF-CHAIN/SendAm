import { render, screen, waitFor } from '@testing-library/react';
import Dashboard from './Dashboard';
import { describe, it, expect } from 'vitest';

describe('Dashboard Component', () => {
  it('renders the settled volume table with per-asset FX conversion and source', async () => {
    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByText('Settled Volume by Asset')).toBeInTheDocument();
    });

    expect(screen.getByText('USD')).toBeInTheDocument();
    expect(screen.getByText('XLM')).toBeInTheDocument();
    expect(screen.getByText('identity')).toBeInTheDocument();
    expect(screen.getByText('exchangerate-api')).toBeInTheDocument();
  });

  it('renders the Live Activity ticker component with pause controls', async () => {
    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 2, name: /live activity/i })).toBeInTheDocument();
    });

    expect(screen.getByTestId('live-activity-ticker')).toBeInTheDocument();
    expect(screen.getByTestId('ticker-status-live')).toBeInTheDocument();
    expect(screen.getByTestId('ticker-pause-button')).toBeInTheDocument();
  });
});
