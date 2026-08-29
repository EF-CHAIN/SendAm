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
    // The total appears both in the page header badge and in the pagination bar.
    expect(screen.getAllByText('Total: 1').length).toBeGreaterThan(0);
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

  it('restores filter state from the URL', async () => {
    // useListQuery bridges filter state to the URL search params, so a page
    // loaded with ?status=success must render that filter preselected.
    render(
      <MemoryRouter initialEntries={['/transactions?status=success']}>
        <Transactions />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByRole('table')).toBeInTheDocument();
    });

    expect(screen.getByLabelText('Status')).toHaveValue('success');
  });
});
