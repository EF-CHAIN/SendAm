import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const fireCapsLockEvent = (element, type, capsLockOn) => {
  const event = new KeyboardEvent(type, { bubbles: true });
  Object.defineProperty(event, 'getModifierState', {
    value: (modifier) => modifier === 'CapsLock' && capsLockOn,
  });
  fireEvent(element, event);
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

  it('toggles password visibility without changing the entered password', async () => {
    const user = userEvent.setup();
    renderLogin();
    const passwordInput = screen.getByLabelText('Password');
    const toggleButton = screen.getByRole('button', { name: 'Show password' });

    await user.type(passwordInput, 'correct_password');
    expect(passwordInput).toHaveAttribute('type', 'password');
    expect(passwordInput).toHaveValue('correct_password');
    expect(toggleButton).toHaveAttribute('type', 'button');

    await user.click(toggleButton);
    expect(passwordInput).toHaveAttribute('type', 'text');
    expect(passwordInput).toHaveValue('correct_password');
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(passwordInput).toHaveAttribute('type', 'password');
    expect(passwordInput).toHaveValue('correct_password');
    expect(screen.getByRole('button', { name: 'Show password' })).toHaveFocus();
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

  it('shows and clears the Caps Lock warning as the password field state changes', () => {
    renderLogin();
    const passwordInput = screen.getByLabelText('Password');

    fireCapsLockEvent(passwordInput, 'keydown', true);
    expect(screen.getByRole('status')).toHaveTextContent('Caps Lock is on');
    expect(passwordInput).toHaveAttribute('aria-describedby', 'login-caps-lock-warning');

    fireCapsLockEvent(passwordInput, 'keyup', false);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(passwordInput).not.toHaveAttribute('aria-describedby');

    fireCapsLockEvent(passwordInput, 'keydown', true);
    expect(screen.getByRole('status')).toBeInTheDocument();
    fireEvent.focus(passwordInput);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    fireCapsLockEvent(passwordInput, 'keydown', true);
    expect(screen.getByRole('status')).toBeInTheDocument();
    fireEvent.blur(passwordInput);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
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
