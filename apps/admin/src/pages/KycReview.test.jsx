import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import KycReview from './KycReview';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { server } from '../mocks/server';
import { http, HttpResponse } from 'msw';
import { installWebAuthnMock, uninstallWebAuthnMock } from '../test/passkeys';

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

// Approve / reject are gated behind the passkey step-up modal, so tests that
// expect a mutation have to satisfy the device prompt first.
const completeStepUp = async () => {
  const dialog = await screen.findByRole('dialog', { name: /biometric step-up required/i });
  await userEvent.click(within(dialog).getByRole('button', { name: /verify with passkey/i }));
};

describe('KycReview Component', () => {
  beforeEach(() => {
    installWebAuthnMock();
  });

  afterEach(() => {
    uninstallWebAuthnMock();
  });

  it('renders KYC profiles and handles approval mutation', async () => {
    renderKyc();
    await waitForTable();

    const table = screen.getByRole('table');
    expect(within(table).getByText(/pending/i)).toBeInTheDocument();
    const approveButton = screen.getByRole('button', { name: /approve/i });
    await userEvent.click(approveButton);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/approve kyc/i)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: /confirm approval/i }));
    await completeStepUp();

    await waitFor(() => {
      expect(within(table).getByText(/approved/i)).toBeInTheDocument();
    });

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
    await completeStepUp();

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
    await completeStepUp();

    await waitFor(() => {
      expect(body).toMatchObject({ status: 'rejected', reason: 'sanctions_flag' });
    });
    // The passkey assertion rides along with the review mutation.
    expect(body.passkeyAssertion.response.signature).toBeTruthy();
    expect(body.passkeyFallback).toBeNull();
  });

  it('requires a passkey assertion before the review mutation is sent', async () => {
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
    const confirmDialog = await screen.findByRole('dialog');
    await userEvent.click(within(confirmDialog).getByRole('button', { name: /confirm approval/i }));

    const stepUp = await screen.findByRole('dialog', { name: /biometric step-up required/i });
    expect(within(stepUp).getByText(/approve kyc record/i)).toBeInTheDocument();
    expect(reviewCalls).toBe(0);

    // Cancelling the passkey prompt must not reach the API.
    await userEvent.click(within(stepUp).getByRole('button', { name: /cancel/i }));
    expect(reviewCalls).toBe(0);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('handles failed mutation gracefully', async () => {
    server.use(
      http.post('*/api/compliance/kyc/:id/review', () => {
        return HttpResponse.json(
          { message: 'KYC failed validation' },
          { status: 400 }
        );
      })
    );

    renderKyc();
    await waitForTable();

    const approveButton = screen.getByRole('button', { name: /approve/i });
    await userEvent.click(approveButton);

    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /confirm approval/i }));
    await completeStepUp();

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        'KYC failed validation'
      );
    });

    // Status should remain pending
    const table = screen.getByRole('table');
    expect(within(table).getByText(/pending/i)).toBeInTheDocument();
  });

  it('opens export modal and completes encrypted export flow', async () => {
    renderKyc();
    await waitForTable();

    const exportBtn = screen.getByTestId('export-kyc');
    await userEvent.click(exportBtn);

    expect(screen.getByTestId('kyc-export-modal')).toBeInTheDocument();
    expect(screen.getByText(/Export KYC Data/i)).toBeInTheDocument();

    const passInput = screen.getByTestId('kyc-export-passphrase');
    const confirmInput = screen.getByTestId('kyc-export-confirm-passphrase');
    await userEvent.type(passInput, 'OperatorPass123!');
    await userEvent.type(confirmInput, 'OperatorPass123!');

    const confirmExportBtn = screen.getByTestId('confirm-export-btn');
    await userEvent.click(confirmExportBtn);

    await waitFor(() => {
      expect(screen.queryByTestId('kyc-export-modal')).not.toBeInTheDocument();
    });
  });

  it('validates passphrase mismatch in export modal', async () => {
    renderKyc();
    await waitForTable();

    await userEvent.click(screen.getByTestId('export-kyc'));

    const passInput = screen.getByTestId('kyc-export-passphrase');
    const confirmInput = screen.getByTestId('kyc-export-confirm-passphrase');
    await userEvent.type(passInput, 'OperatorPass123!');
    await userEvent.type(confirmInput, 'DifferentPass123!');

    await userEvent.click(screen.getByTestId('confirm-export-btn'));

    expect(screen.getByRole('alert')).toHaveTextContent(
      /Passphrases do not match/i
    );
  });
});
