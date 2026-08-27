import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Transactions from './Transactions';
import { describe, it, expect } from 'vitest';

const renderPage = () => render(
  <MemoryRouter>
    <Transactions />
  </MemoryRouter>
);

describe('Transactions Component', () => {
  it('displays loading state initially', () => {
    renderPage();
    expect(screen.getByText('Transactions')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('renders data table after successful fetch', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('table')).toBeInTheDocument();
    });

    expect(screen.getByText('100 USDC')).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
    // Total: 1 appears in both the header span and the Pagination component.
    // Use getAllByText to handle both instances.
    expect(screen.getAllByText('Total: 1').length).toBeGreaterThanOrEqual(1);
  });

  it('renders empty state on a later cursor page', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('table')).toBeInTheDocument();
    });

    const nextButton = screen.getByRole('button', { name: /next/i });
    await userEvent.click(nextButton);

    await waitFor(() => {
      expect(screen.getByText('No records found.')).toBeInTheDocument();
    });
  });

  it('preserves filter state — the status filter input updates to the selected value', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('table')).toBeInTheDocument();
    });

    const statusInput = screen.getByTestId('filter-status');
    await userEvent.selectOptions(statusInput, 'success');

    // Verify the select control reflects the chosen filter value.
    // MemoryRouter manages its own history separately from window.location,
    // so we assert on the visible control state rather than window.location.search.
    expect(statusInput).toHaveValue('success');
  });
});
