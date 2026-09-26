import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import Users from './Users';
import { server } from '../mocks/server';
import { installWebAuthnMock, uninstallWebAuthnMock } from '../test/passkeys';

const renderUsers = () =>
  render(
    <MemoryRouter>
      <Users />
    </MemoryRouter>
  );

const waitForTable = async () => {
  await waitFor(() => {
    expect(screen.getByRole('table')).toBeInTheDocument();
  });
};

// Opens the deactivation confirmation, then confirms it. The mutation must not
// reach the API until the passkey prompt is satisfied.
const confirmDeactivation = async () => {
  await userEvent.click(screen.getByRole('button', { name: /^deactivate$/i }));
  await userEvent.click(screen.getByRole('button', { name: /confirm deactivation/i }));
};

afterEach(() => {
  uninstallWebAuthnMock();
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

    renderUsers();
    await waitForTable();
    await confirmDeactivation();

    const dialog = await screen.findByRole('dialog', { name: /biometric step-up required/i });
    // Intercepted: the destructive request has not been sent yet.
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
    // No WebAuthn stub installed: capability detection reports "unsupported".
    let body = null;
    server.use(
      http.post('*/api/admin/users/:id/deactivate', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ data: { success: true } });
      })
    );

    renderUsers();
    await waitForTable();
    await confirmDeactivation();

    const dialog = await screen.findByRole('dialog', { name: /biometric step-up required/i });
    // Capability detection resolves asynchronously, so wait for the fallback UI.
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

    renderUsers();
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
