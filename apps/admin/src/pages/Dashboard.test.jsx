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
});
