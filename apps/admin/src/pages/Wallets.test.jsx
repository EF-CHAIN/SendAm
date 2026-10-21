import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { describe, it, expect } from 'vitest';
import Wallets from './Wallets';
import { server } from '@/mocks/server';

const renderPage = () => render(
  <MemoryRouter>
    <Wallets />
  </MemoryRouter>
);

describe('Wallets error handling', () => {
  it('shows an alert banner instead of an empty table when the fetch fails', async () => {
    server.use(
      http.get('*/api/admin/wallets', () =>
        HttpResponse.json({ message: 'Database connection failed' }, { status: 500 })
      )
    );
    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('A server error occurred');
    expect(alert.textContent).not.toContain('Database connection failed');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try Again' })).toBeInTheDocument();
  });

  it('re-attempts the fetch when Try Again is clicked', async () => {
    let calls = 0;
    server.use(
      http.get('*/api/admin/wallets', () => {
        calls += 1;
        if (calls === 1) return HttpResponse.json({ message: 'boom' }, { status: 500 });
        return HttpResponse.json({
          data: [],
          pagination: { limit: 50, nextCursor: null, prevCursor: null, hasMore: false, total: 0 },
        });
      })
    );
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Try Again' }));

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(calls).toBe(2);
    expect(await screen.findByText('No records found.')).toBeInTheDocument();
  });
});
