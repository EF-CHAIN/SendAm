import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import Login from './Login';
import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

// Use MemoryRouter to avoid jsdom's "Not implemented: navigation" error that
// fires when Login calls navigate('/') after a successful login via BrowserRouter.
const renderLogin = () => {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<div data-testid="dashboard">Dashboard</div>} />
      </Routes>
    </MemoryRouter>
  );
};

describe('Login Component', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders login form correctly', () => {
    renderLogin();
    expect(screen.getByPlaceholderText('Enter password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('toggles password visibility with an accessible control', async () => {
    const user = userEvent.setup();
    renderLogin();
    const passwordInput = screen.getByLabelText('Password');

    expect(passwordInput).toHaveAttribute('type', 'password');
    await user.click(screen.getByRole('button', { name: 'Show password' }));
    expect(passwordInput).toHaveAttribute('type', 'text');

    await user.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(passwordInput).toHaveAttribute('type', 'password');
  });

  it('shows a spinner and disables submit while authenticating', async () => {
    let resolveLogin;
    const loginResponse = new Promise((resolve) => {
      resolveLogin = resolve;
    });
    server.use(
      http.post('*/api/admin/login', async () => {
        await loginResponse;
        return HttpResponse.json({ data: { token: 'fake_token' } });
      })
    );

    const user = userEvent.setup();
    renderLogin();
    await user.type(screen.getByLabelText('Email'), 'operator@example.com');
    await user.type(screen.getByLabelText('Password'), 'correct_password');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    const submitButton = screen.getByRole('button', { name: /signing in/i });
    expect(submitButton).toBeDisabled();
    expect(submitButton.querySelector('svg')).toHaveClass('animate-spin');

    resolveLogin();
    await waitFor(() => {
      expect(screen.getByTestId('dashboard')).toBeInTheDocument();
    });
  });

  it('handles successful login and redirects to dashboard', async () => {
    renderLogin();
    // Both fields are required; the email must be filled or HTML5 constraint
    // validation blocks form submission (matching real browser behavior).
    const emailInput = screen.getByPlaceholderText('you@example.com');
    const passwordInput = screen.getByPlaceholderText('Enter password');
    const submitButton = screen.getByRole('button', { name: /sign in/i });

    await userEvent.type(emailInput, 'operator@example.com');
    await userEvent.type(passwordInput, 'correct_password');
    await userEvent.click(submitButton);

    // On success, navigate('/') renders the dashboard route
    await waitFor(() => {
      expect(screen.getByTestId('dashboard')).toBeInTheDocument();
    });

    expect(localStorage.getItem('adminToken')).toBe('fake_token');
  });

  it('handles failed login and displays error', async () => {
    renderLogin();
    const emailInput = screen.getByPlaceholderText('you@example.com');
    const passwordInput = screen.getByPlaceholderText('Enter password');
    const submitButton = screen.getByRole('button', { name: /sign in/i });

    await userEvent.type(emailInput, 'operator@example.com');
    await userEvent.type(passwordInput, 'wrong_password');
    await userEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText('Invalid credentials')).toBeInTheDocument();
    });

    expect(passwordInput).toHaveAttribute('aria-invalid', 'true');
    expect(passwordInput).toHaveAttribute('aria-describedby', 'login-error');
    expect(emailInput).toHaveAttribute('aria-invalid', 'true');
    expect(emailInput).toHaveAttribute('aria-describedby', 'login-error');
    expect(screen.getByRole('alert')).toHaveAttribute('id', 'login-error');
    
    expect(localStorage.getItem('adminToken')).toBeNull();
  });
});
