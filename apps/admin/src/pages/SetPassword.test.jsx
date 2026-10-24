import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { axe } from 'jest-axe';
import { server } from '../mocks/server';
import SetPassword from './SetPassword';

// Public synthetic fixtures only. The real API is intercepted by MSW.
const STRONG_PASSWORD = 'orchid nebula lantern glacier';
const CURRENT_PASSWORD = 'temporary-credential';
let requests;

const renderPage = () => render(
  <MemoryRouter initialEntries={['/set-password']}>
    <Routes>
      <Route path="/set-password" element={<SetPassword />} />
      <Route path="/" element={<h1>Dashboard</h1>} />
    </Routes>
  </MemoryRouter>
);
const currentInput = () => screen.getByLabelText('Current password');
const newInput = () => screen.getByLabelText('New password');
const confirmInput = () => screen.getByLabelText('Confirm new password');
const submitButton = () => screen.getByRole('button', { name: 'Set Password' });
const fillForm = (password = STRONG_PASSWORD, confirmation = password) => {
  fireEvent.change(currentInput(), { target: { value: CURRENT_PASSWORD } });
  fireEvent.change(newInput(), { target: { value: password } });
  fireEvent.change(confirmInput(), { target: { value: confirmation } });
};

beforeEach(() => {
  localStorage.clear();
  requests = vi.fn();
  server.use(http.post('*/api/admin/password', async ({ request }) => {
    requests(await request.json(), request.headers.get('authorization'));
    return HttpResponse.json({ success: true });
  }));
});
afterEach(() => vi.restoreAllMocks());

describe('SetPassword', () => {
  it('starts with an empty accessible meter, requirements and disabled submit', () => {
    renderPage();
    expect(submitButton()).toBeDisabled();
    expect(screen.getByRole('meter', { name: 'Password strength' })).toHaveAttribute('aria-valuenow', '0');
    expect(screen.getByRole('status')).toHaveTextContent('Not entered');
    expect(newInput()).toHaveAttribute('minlength', '12');
    expect(newInput()).toHaveAttribute('aria-describedby', 'password-strength-status password-strength-feedback password-requirements');
    expect(within(screen.getByRole('list', { name: 'Password requirements' })).getAllByText(/Not met:/)).toHaveLength(3);
    for (const input of [currentInput(), newInput(), confirmInput()]) expect(input).toHaveAttribute('type', 'password');
  });

  it('updates locally while typing, supports all four levels and resets when cleared', async () => {
    renderPage();
    const user = userEvent.setup();
    const write = vi.spyOn(Storage.prototype, 'setItem');
    await user.type(newInput(), 'Password123!');
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuetext', 'Weak');
    for (const [password, label, level] of [
      ['sunshine2026!', 'Fair', '2'], ['horizon2026!?', 'Good', '3'], [STRONG_PASSWORD, 'Strong', '4'],
    ]) {
      fireEvent.change(newInput(), { target: { value: password } });
      expect(screen.getByRole('meter')).toHaveAttribute('aria-valuetext', label);
      expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', level);
      expect(submitButton().disabled).toBe(level !== '4');
    }
    await user.clear(newInput());
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '0');
    expect(submitButton()).toBeDisabled();
    expect(requests).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it.each(['short', 'Password123!', 'P@ssw0rd12345!', 'qwertyuiop123', 'sunshine2026!', 'horizon2026!?'])('blocks non-Strong fixture %#, including direct form submission', (password) => {
    renderPage();
    fillForm(password);
    expect(submitButton()).toBeDisabled();
    fireEvent.submit(newInput().form);
    expect(screen.getByRole('alert')).toHaveTextContent(password.length < 12 ? 'Password must be at least 12 characters.' : 'Choose a password with a Strong rating.');
    expect(requests).not.toHaveBeenCalled();
  });

  it('preserves required current-password validation and mismatch errors', async () => {
    renderPage();
    fillForm(STRONG_PASSWORD, 'different-password');
    fireEvent.change(currentInput(), { target: { value: '' } });
    fireEvent.submit(newInput().form);
    expect(screen.getByRole('alert')).toHaveTextContent('Enter your current password.');
    fireEvent.change(currentInput(), { target: { value: CURRENT_PASSWORD } });
    await userEvent.click(submitButton());
    expect(screen.getByRole('alert')).toHaveTextContent('Passwords do not match.');
    expect(confirmInput()).toHaveAttribute('aria-invalid', 'true');
    expect(requests).not.toHaveBeenCalled();
    fireEvent.change(confirmInput(), { target: { value: STRONG_PASSWORD } });
    expect(confirmInput()).toHaveAttribute('aria-invalid', 'false');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(within(screen.getByRole('list')).getAllByText(/^Met:/)).toHaveLength(3);
  });

  it('invalidates a previously matching confirmation and disables a weakened password', () => {
    renderPage();
    fillForm();
    expect(submitButton()).toBeEnabled();
    fireEvent.change(newInput(), { target: { value: 'Password123!' } });
    expect(submitButton()).toBeDisabled();
    expect(confirmInput()).toHaveAttribute('aria-invalid', 'true');
    expect(requests).not.toHaveBeenCalled();
  });

  it('uses high-contrast Fair segments while retaining the text rating', () => {
    renderPage();
    fillForm('sunshine2026!');
    const meter = screen.getByRole('meter');
    expect(meter).toHaveAttribute('aria-valuetext', 'Fair');
    expect(screen.getByRole('status')).toHaveTextContent('Password strength: Fair');
    const segments = meter.querySelectorAll('.h-2');
    // Tailwind amber-700 (#b45309): 5.02:1 on white, 4.06:1 against the
    // inactive gray-200 segments. Keep the visual state above 3:1.
    expect(segments[0]).toHaveClass('bg-amber-700');
    expect(segments[1]).toHaveClass('bg-amber-700');
    expect(segments[2]).toHaveClass('bg-gray-200');
    expect(segments[3]).toHaveClass('bg-gray-200');
    expect(submitButton()).toBeDisabled();
  });

  it('submits the original full values and existing session token, then navigates', async () => {
    localStorage.setItem('adminToken', 'test-session');
    renderPage();
    const longPassword = `${STRONG_PASSWORD} ${'unusual phrase '.repeat(8)}  `;
    fillForm(longPassword);
    await userEvent.click(submitButton());
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(requests).toHaveBeenCalledExactlyOnceWith({ currentPassword: CURRENT_PASSWORD, newPassword: longPassword }, 'Bearer test-session');
    expect(localStorage.getItem('adminToken')).toBe('test-session');
  });

  it('locks the form and prevents repeated submissions while the API is pending', async () => {
    let finish;
    const pending = new Promise((resolve) => { finish = resolve; });
    server.use(http.post('*/api/admin/password', async () => {
      requests();
      await pending;
      return HttpResponse.json({ success: true });
    }));
    renderPage();
    fillForm();
    const form = newInput().form;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(screen.getByRole('button', { name: 'Setting password...' })).toBeDisabled();
    expect(form).toHaveAttribute('aria-busy', 'true');
    for (const input of [currentInput(), newInput(), confirmInput()]) expect(input).toBeDisabled();
    await waitFor(() => expect(requests).toHaveBeenCalledTimes(1));
    finish();
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
  });

  it.each([
    [HttpResponse.json({ message: 'Current password is incorrect.' }, { status: 400 }), 'Current password is incorrect.'],
    [HttpResponse.json({}, { status: 500 }), 'Could not set a new password.'],
    [HttpResponse.error(), 'Could not set a new password.'],
  ])('preserves API/network error fixture %# and allows correction and retry', async (response, message) => {
    server.use(http.post('*/api/admin/password', () => response, { once: true }));
    renderPage();
    fillForm();
    await userEvent.click(submitButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(submitButton()).toBeEnabled();
    expect(currentInput()).toBeEnabled();
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).not.toBeInTheDocument();
    await userEvent.click(submitButton());
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
  });

  it('preserves the existing 401 session-revocation behavior', async () => {
    // Avoid jsdom's unsupported full-page navigation; the existing interceptor
    // still removes the invalid token when already at the login URL.
    window.history.replaceState({}, '', '/login');
    localStorage.setItem('adminToken', 'revoked-session');
    server.use(http.post('*/api/admin/password', () => HttpResponse.json({ message: 'Session expired.' }, { status: 401 })));
    renderPage();
    fillForm();
    await userEvent.click(submitButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('Session expired.');
    expect(localStorage.getItem('adminToken')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).not.toBeInTheDocument();
    window.history.replaceState({}, '', '/');
  });

  it('has no automated accessibility violations in empty or completed states', async () => {
    const { container } = renderPage();
    expect(await axe(container)).toHaveNoViolations();
    fillForm();
    expect(await axe(container)).toHaveNoViolations();
    const segments = screen.getByRole('meter').querySelectorAll('.h-2');
    expect(segments).toHaveLength(4);
    segments.forEach((segment) => expect(segment).toHaveClass('motion-reduce:transition-none'));
  });
});
