import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import KycReview from './KycReview';
import { describe, it, expect } from 'vitest';
import { server } from '../mocks/server';
import { http, HttpResponse } from 'msw';

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

    expect(screen.getByText('Pending')).toBeInTheDocument();
    const approveButton = screen.getByRole('button', { name: /approve/i });
    
    await userEvent.click(approveButton);

    await waitFor(() => {
      expect(screen.getByText('Approved')).toBeInTheDocument();
    });
    
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

    const rejectButton = screen.getByRole('button', { name: /reject/i });
    await userEvent.click(rejectButton);

    await waitFor(() => {
      expect(screen.getByText('Rejected')).toBeInTheDocument();
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
    
    // Status should remain Pending
    expect(screen.getByText('Pending')).toBeInTheDocument();
  });
});
