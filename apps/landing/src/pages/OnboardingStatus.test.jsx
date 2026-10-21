import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import OnboardingStatus from './OnboardingStatus.jsx';
import api from '@shared/api';

vi.mock('@shared/api');

const mockPendingResponse = {
  data: {
    success: true,
    data: {
      stage: 'in_progress',
      percentComplete: 67,
      checkpoints: [
        { id: 'account_created', label: 'Account created', description: 'Your WhatsApp account is registered.', complete: true },
        { id: 'wallet_ready', label: 'Wallet ready', description: 'Your Stellar wallet has been funded.', complete: true },
      ],
      nextStep: { action: 'await_review', message: 'Verification under review' },
      blockers: [],
      kyc: { status: 'pending', tier: 0, sanctionsStatus: 'cleared' },
      wallet: { funded: true, fundingState: 'succeeded', trustlineState: 'succeeded', network: 'testnet' },
      accountActive: true,
      computedAt: new Date().toISOString(),
    },
  },
};

describe('OnboardingStatus Page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockResolvedValue(mockPendingResponse);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders checkpoints and progress overview', async () => {
    render(<OnboardingStatus />);
    expect(await screen.findByText('Onboarding Checkpoints')).toBeInTheDocument();
    expect(screen.getByText('Account created')).toBeInTheDocument();
    expect(screen.getByText('Wallet ready')).toBeInTheDocument();
  });

  it('displays the circular progress countdown ring and decrements every second', async () => {
    vi.useFakeTimers();
    render(<OnboardingStatus />);

    // Resolve initial fetch
    await act(async () => {
      await Promise.resolve();
    });

    const countdown = screen.getByTestId('polling-countdown');
    expect(countdown).toBeInTheDocument();
    expect(countdown).toHaveTextContent(/Auto-refresh in 10s/i);

    // Advance 3 seconds
    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(countdown).toHaveTextContent(/Auto-refresh in 7s/i);
  });

  it('automatically triggers refetch when countdown reaches 0', async () => {
    vi.useFakeTimers();
    render(<OnboardingStatus />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(api.get).toHaveBeenCalledTimes(1);

    // Advance 10 seconds to trigger automated poll
    await act(async () => {
      vi.advanceTimersByTime(10000);
    });

    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('allows pausing and resuming auto-refresh via toggle button', async () => {
    vi.useFakeTimers();
    render(<OnboardingStatus />);

    await act(async () => {
      await Promise.resolve();
    });

    const toggleBtn = screen.getByTestId('toggle-polling-button');
    expect(toggleBtn).toHaveAttribute('aria-label', 'Pause auto-refresh');

    // Click pause
    fireEvent.click(toggleBtn);
    expect(toggleBtn).toHaveAttribute('aria-label', 'Resume auto-refresh');
    expect(screen.getByTestId('polling-countdown')).toHaveTextContent(/Auto-refresh paused/i);

    // Advance time while paused - should not call api.get
    await act(async () => {
      vi.advanceTimersByTime(15000);
    });
    expect(api.get).toHaveBeenCalledTimes(1);

    // Click resume
    fireEvent.click(toggleBtn);
    expect(toggleBtn).toHaveAttribute('aria-label', 'Pause auto-refresh');

    // Advance 10 seconds to trigger next poll
    await act(async () => {
      vi.advanceTimersByTime(10000);
    });
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('cleans up interval on unmount without leaking timers', async () => {
    vi.useFakeTimers();
    const { unmount } = render(<OnboardingStatus />);

    await act(async () => {
      await Promise.resolve();
    });

    unmount();

    await act(async () => {
      vi.advanceTimersByTime(20000);
    });

    expect(api.get).toHaveBeenCalledTimes(1);
  });
});
