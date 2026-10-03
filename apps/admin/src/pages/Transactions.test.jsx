import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Transactions from './Transactions';
import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

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

  it('fetches a fresh first page with the selected limit', async () => {
    const requests = [];
    server.use(http.get('*/api/admin/transactions', ({ request }) => {
      const query = new URL(request.url).searchParams;
      requests.push({ limit: query.get('limit'), after: query.get('after') });
      return HttpResponse.json({
        data: [{ _id: 'tx1', type: 'deposit', amount: query.get('limit') === '25' ? '25' : '100', asset: 'USDC', status: 'Completed', createdAt: new Date().toISOString() }],
        pagination: { limit: Number(query.get('limit')) || 50, nextCursor: null, prevCursor: null, hasMore: false, total: 1 },
      });
    }));

    render(
      <MemoryRouter initialEntries={['/transactions?after=old&limit=25']}>
        <Transactions />
      </MemoryRouter>
    );
    await screen.findByText('25 USDC');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Items per page' }), '100');
    await screen.findByText('100 USDC');
    expect(requests.at(-1)).toEqual({ limit: '100', after: null });
  });
});
