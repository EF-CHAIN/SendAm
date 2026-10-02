import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import Users from './Users';
import { server } from '../mocks/server';
import { installWebAuthnMock, uninstallWebAuthnMock } from '../test/passkeys';

const renderPage = (initialEntries = ['/users']) => render(
  <MemoryRouter initialEntries={initialEntries}>
    <Users />
  </MemoryRouter>
);

const waitForTable = async () => {
  await waitFor(() => {
    expect(screen.getByRole('table')).toBeInTheDocument();
  });
};

const confirmDeactivation = async () => {
  await userEvent.click(screen.getByRole('button', { name: /^deactivate$/i }));
  await userEvent.click(screen.getByRole('button', { name: /confirm deactivation/i }));
};

afterEach(() => {
  uninstallWebAuthnMock();
});

describe('Users Component', () => {
  it('displays loading state initially', () => {
    renderPage();
    expect(screen.getByText('Users')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('renders the data table after a successful fetch', async () => {
    renderPage();

    await waitForTable();

    expect(screen.getByText('+1234567890')).toBeInTheDocument();
    expect(screen.getAllByText(/Total: 1/).length).toBeGreaterThan(0);
  });

  it('renders the empty state when the phone filter matches nobody', async () => {
    renderPage(['/users?phone=missing']);

    await waitFor(() => {
      expect(screen.getByText('No records found.')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Phone')).toHaveValue('missing');
  });

  it('stays up and renders the empty table when the API errors', async () => {
    server.use(
      http.get('*/api/admin/users', () => (
        HttpResponse.json({ message: 'Server error' }, { status: 500 })
      )),
    );

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('No records found.')).toBeInTheDocument();
    });
    expect(screen.getByText('Users')).toBeInTheDocument();
  });
});

describe('Users high-risk action step-up', () => {
  it('attaches a passkey assertion before deactivating an account', async () => {
    installWebAuthnMock();
    let body = null;
    server.use(
      http.post('*/api/admin/users/:id/deactivate', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ data: { success: true } });
      })
    );

    renderPage();
    await waitForTable();
    await confirmDeactivation();

    const dialog = await screen.findByRole('dialog', { name: /biometric step-up required/i });
    expect(body).toBeNull();

    await userEvent.click(within(dialog).getByRole('button', { name: /verify with passkey/i }));

    await waitFor(() => {
      expect(screen.getByText(/account deactivated successfully/i)).toBeInTheDocument();
    });
    expect(body).toMatchObject({ reason: 'risk_score_exceeded', passkeyFallback: null });
    expect(body.passkeyAssertion.response.signature).toBeTruthy();
    expect(body.passkeyAssertion.response.clientDataJSON).toBeTruthy();
  });

  it('allows an acknowledged fallback when the device cannot do WebAuthn', async () => {
    let body = null;
    server.use(
      http.post('*/api/admin/users/:id/deactivate', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ data: { success: true } });
      })
    );

    renderPage();
    await waitForTable();
    await confirmDeactivation();

    const dialog = await screen.findByRole('dialog', { name: /biometric step-up required/i });
    const continueButton = await within(dialog).findByRole('button', {
      name: /continue without passkey/i,
    });
    expect(
      within(dialog).queryByRole('button', { name: /verify with passkey/i })
    ).not.toBeInTheDocument();
    expect(continueButton).toBeDisabled();

    await userEvent.click(within(dialog).getByRole('checkbox'));
    expect(continueButton).toBeEnabled();
    await userEvent.click(continueButton);

    await waitFor(() => {
      expect(body).not.toBeNull();
    });
    expect(body.passkeyAssertion).toBeNull();
    expect(body.passkeyFallback).toBe('unsupported_device');
  });

  it('requires step-up before downloading a compliance evidence package', async () => {
    installWebAuthnMock();
    let downloadCalls = 0;
    server.use(
      http.get('*/api/admin/compliance/evidence/:id/download', () => {
        downloadCalls += 1;
        return HttpResponse.json({ data: {} });
      })
    );

    renderPage();
    await waitForTable();
    await userEvent.click(screen.getByRole('button', { name: /evidence/i }));

    const dialog = await screen.findByRole('dialog', { name: /biometric step-up required/i });
    expect(within(dialog).getByText(/download compliance evidence package/i)).toBeInTheDocument();
    expect(downloadCalls).toBe(0);

    await userEvent.click(within(dialog).getByRole('button', { name: /cancel/i }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(downloadCalls).toBe(0);
  });
});
