import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import KycReview from './KycReview';
import { describe, it, expect } from 'vitest';
import { server } from '../mocks/server';
import { http, HttpResponse } from 'msw';

// Helper: find the StatusBadge span for a given status value.
// The FilterBar's status <select> also contains the same text as <option>
// elements, so we scope to the table cell to avoid ambiguity.
function getBadgeText(status) {
  return screen.getAllByText(status).find(
    (el) => el.tagName === 'SPAN' && el.className.includes('rounded-full')
  );
}

describe('KycReview Component', () => {
  it('renders KYC profiles and handles approval mutation', async () => {
    render(
      <MemoryRouter>
        <KycReview />
      </MemoryRouter>
    );
    
    await waitFor(() => {
      expect(screen.getByRole('table')).toBeInTheDocument();
    });

    // The status badge renders the lowercase API status; the capitalize
    // styling is purely visual, so match case-insensitively within the table.
    const table = screen.getByRole('table');
    expect(within(table).getByText(/pending/i)).toBeInTheDocument();
    const approveButton = screen.getByRole('button', { name: /approve/i });
    await userEvent.click(approveButton);

    await waitFor(() => {
      expect(within(table).getByText(/approved/i)).toBeInTheDocument();
    });
    
    // Approve/Reject action buttons should no longer appear for this record
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
  });

  it('renders KYC profiles and handles rejection mutation', async () => {
    render(
      <MemoryRouter>
        <KycReview />
      </MemoryRouter>
    );
    
    await waitFor(() => {
      expect(screen.getByRole('table')).toBeInTheDocument();
    });

    const table = screen.getByRole('table');
    const rejectButton = screen.getByRole('button', { name: /reject/i });
    await userEvent.click(rejectButton);

    await waitFor(() => {
      expect(within(table).getByText(/rejected/i)).toBeInTheDocument();
    });
  });

  it('handles failed mutation gracefully', async () => {
    server.use(
      http.post('*/api/compliance/kyc/:id/review', () => {
        return HttpResponse.json({ message: 'KYC failed validation' }, { status: 400 });
      })
    );

    render(
      <MemoryRouter>
        <KycReview />
      </MemoryRouter>
    );
    
    await waitFor(() => {
      expect(screen.getByRole('table')).toBeInTheDocument();
    });

    const approveButton = screen.getByRole('button', { name: /approve/i });
    await userEvent.click(approveButton);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('KYC failed validation');
    });
    
    // Status should remain pending
    const table = screen.getByRole('table');
    expect(within(table).getByText(/pending/i)).toBeInTheDocument();
  });
});
