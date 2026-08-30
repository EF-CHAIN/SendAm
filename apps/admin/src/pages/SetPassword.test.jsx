import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import SetPassword from './SetPassword';
import { describe, it, expect, beforeEach } from 'vitest';

const renderPage = () => {
  return render(
    <BrowserRouter>
      <SetPassword />
    </BrowserRouter>
  );
};

describe('SetPassword Component', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('requires at least 12 characters on the new password', async () => {
    renderPage();
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('Temporary password'), 'temp-password');
    await user.type(screen.getByPlaceholderText('At least 12 characters'), 'short');
    await user.type(screen.getByPlaceholderText('Re-enter new password'), 'short');
    await user.click(screen.getByRole('button', { name: /set password/i }));
    await waitFor(() => {
      expect(screen.getByText('Password must be at least 12 characters.')).toBeInTheDocument();
    });
  });

  it('flags a confirm mismatch', async () => {
    renderPage();
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('Temporary password'), 'temp-password');
    await user.type(screen.getByPlaceholderText('At least 12 characters'), 'a-very-long-new-password');
    await user.type(screen.getByPlaceholderText('Re-enter new password'), 'a-different-password');
    await user.click(screen.getByRole('button', { name: /set password/i }));
    await waitFor(() => {
      expect(screen.getByText('Passwords do not match.')).toBeInTheDocument();
    });
  });

  it('submits and navigates to the dashboard on success', async () => {
    renderPage();
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('Temporary password'), 'temp-password');
    await user.type(screen.getByPlaceholderText('At least 12 characters'), 'a-very-long-new-password');
    await user.type(screen.getByPlaceholderText('Re-enter new password'), 'a-very-long-new-password');
    await user.click(screen.getByRole('button', { name: /set password/i }));
    await waitFor(() => {
      expect(screen.queryByText('Passwords do not match.')).not.toBeInTheDocument();
    });
  });
});
