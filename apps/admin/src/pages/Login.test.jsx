import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import Login from './Login';
import { describe, it, expect, beforeEach } from 'vitest';

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

  it('handles successful login and redirects to dashboard', async () => {
    renderLogin();

    await userEvent.type(screen.getByPlaceholderText('you@example.com'), 'admin@example.com');
    await userEvent.type(screen.getByPlaceholderText('Enter password'), 'correct_password');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    // On success, navigate('/') renders the dashboard route
    await waitFor(() => {
      expect(screen.getByTestId('dashboard')).toBeInTheDocument();
    });

    expect(localStorage.getItem('adminToken')).toBe('fake_token');
  });

  it('handles failed login and displays error', async () => {
    renderLogin();

    await userEvent.type(screen.getByPlaceholderText('you@example.com'), 'admin@example.com');
    await userEvent.type(screen.getByPlaceholderText('Enter password'), 'wrong_password');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(screen.getByText('Invalid credentials')).toBeInTheDocument();
    });
    
    expect(localStorage.getItem('adminToken')).toBeNull();
  });
});
