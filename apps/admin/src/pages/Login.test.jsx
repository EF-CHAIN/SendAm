import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import Login from './Login';
import { describe, it, expect, beforeEach } from 'vitest';

const renderLogin = () => {
  return render(
    <BrowserRouter>
      <Login />
    </BrowserRouter>
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

  it('handles successful login and redirects', async () => {
    renderLogin();
    const passwordInput = screen.getByPlaceholderText('Enter password');
    const submitButton = screen.getByRole('button', { name: /sign in/i });

    await userEvent.type(passwordInput, 'correct_password');
    await userEvent.click(submitButton);

    await waitFor(() => {
      expect(localStorage.getItem('adminToken')).toBe('fake_token');
    });
  });

  it('handles failed login and displays error', async () => {
    renderLogin();
    const passwordInput = screen.getByPlaceholderText('Enter password');
    const submitButton = screen.getByRole('button', { name: /sign in/i });

    await userEvent.type(passwordInput, 'wrong_password');
    await userEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText('Invalid credentials')).toBeInTheDocument();
    });
    
    expect(localStorage.getItem('adminToken')).toBeNull();
  });
});
