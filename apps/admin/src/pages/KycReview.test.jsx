import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import KycReview from './KycReview';
import { describe, it, expect } from 'vitest';
import { server } from '../mocks/server';
import { http, HttpResponse } from 'msw';

const renderKyc = () =>
  render(
    <MemoryRouter>
      <KycReview />
    </MemoryRouter>
  );

const waitForTable = async () => {
  await waitFor(() => {
    expect(screen.getByRole('table')).toBeInTheDocument();
  });
};

describe('KycReview Component', () => {
  it('renders KYC profiles and handles approval mutation', async () => {
    renderKyc();
    await waitForTable();

    // The status badge renders the lowercase API status; the capitalize
    // styling is purely visual, so match case-insensitively within the table.
    const table = screen.getByRole('table');
    expect(within(table).getByText(/pending/i)).toBeInTheDocument();
    const approveButton = screen.getByRole('button', { name: /approve/i });
    await userEvent.click(approveButton);

    // Approval now requires explicit modal confirmation.
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/approve kyc/i)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: /confirm approval/i }));

    await waitFor(() => {
      expect(within(table).getByText(/approved/i)).toBeInTheDocument();
    });

    // Approve/Reject action buttons should no longer appear for this record
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
  });

  it('does not call the API until the approval modal is confirmed', async () => {
    let reviewCalls = 0;
    server.use(
      http.post('*/api/compliance/kyc/:id/review', () => {
        reviewCalls += 1;
        return HttpResponse.json({ success: true });
      })
    );

    renderKyc();
    await waitForTable();

    await userEvent.click(screen.getByRole('button', { name: /approve/i }));
    const dialog = await screen.findByRole('dialog');
    expect(reviewCalls).toBe(0);

    // Cancelling must not mutate anything.
    await userEvent.click(within(dialog).getByRole('button', { name: /cancel/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(reviewCalls).toBe(0);
    expect(within(screen.getByRole('table')).getByText(/pending/i)).toBeInTheDocument();
  });

  it('shows the customer phone and risk score in the approval modal', async () => {
    renderKyc();
    await waitForTable();

    await userEvent.click(screen.getByRole('button', { name: /approve/i }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByTestId('confirm-phone')).toHaveTextContent('+1234567890');
    expect(within(dialog).getByTestId('confirm-risk')).toHaveTextContent('Low');
  });

  it('renders KYC profiles and handles rejection mutation', async () => {
    renderKyc();
    await waitForTable();

    const table = screen.getByRole('table');
    const rejectButton = screen.getByRole('button', { name: /reject/i });
    await userEvent.click(rejectButton);

    const dialog = await screen.findByRole('dialog');
    await userEvent.selectOptions(
      within(dialog).getByLabelText(/rejection reason/i),
      'document_expired'
    );
    await userEvent.click(within(dialog).getByRole('button', { name: /confirm rejection/i }));

    await waitFor(() => {
      expect(within(table).getByText(/rejected/i)).toBeInTheDocument();
    });
  });

  it('disables rejection submit until a valid reason is provided', async () => {
    renderKyc();
    await waitForTable();

    await userEvent.click(screen.getByRole('button', { name: /reject/i }));
    const dialog = await screen.findByRole('dialog');

    const submit = within(dialog).getByRole('button', { name: /confirm rejection/i });
    expect(submit).toBeDisabled();

    // Selecting a concrete reason code enables submission.
    await userEvent.selectOptions(
      within(dialog).getByLabelText(/rejection reason/i),
      'name_mismatch'
    );
    expect(submit).toBeEnabled();

    // "Other" requires free-text detail before it can be submitted.
    await userEvent.selectOptions(within(dialog).getByLabelText(/rejection reason/i), 'other');
    expect(submit).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/reason detail/i), 'Blurry selfie');
    expect(submit).toBeEnabled();
  });

  it('sends the selected rejection reason to the API', async () => {
    let body = null;
    server.use(
      http.post('*/api/compliance/kyc/:id/review', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ success: true });
      })
    );

    renderKyc();
    await waitForTable();

    await userEvent.click(screen.getByRole('button', { name: /reject/i }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.selectOptions(
      within(dialog).getByLabelText(/rejection reason/i),
      'sanctions_flag'
    );
    await userEvent.click(within(dialog).getByRole('button', { name: /confirm rejection/i }));

    await waitFor(() => {
      expect(body).toMatchObject({ status: 'rejected', reason: 'sanctions_flag' });
    });
  });

  it('handles failed mutation gracefully', async () => {
    server.use(
      http.post('*/api/compliance/kyc/:id/review', () => {
        return HttpResponse.json({ message: 'KYC failed validation' }, { status: 400 });
      })
    );

    renderKyc();
    await waitForTable();

    const approveButton = screen.getByRole('button', { name: /approve/i });
    await userEvent.click(approveButton);

    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /confirm approval/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('KYC failed validation');
    });

    // Status should remain pending
    const table = screen.getByRole('table');
    expect(within(table).getByText(/pending/i)).toBeInTheDocument();
  });
});
