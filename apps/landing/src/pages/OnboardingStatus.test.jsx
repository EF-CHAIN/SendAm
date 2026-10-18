import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import OnboardingStatus from './OnboardingStatus.jsx';
import api from '@shared/api';

vi.mock('@shared/api', () => ({
  default: {
    get: vi.fn(),
  },
}));

const mockStatusWithAddress = {
  stage: 'in_progress',
  percentComplete: 67,
  checkpoints: [
    { id: 'account_created', label: 'Account created', description: 'Registered', complete: true },
    { id: 'wallet_ready', label: 'Wallet ready', description: 'Wallet ready', complete: true },
  ],
  nextStep: { action: 'await_review', message: 'Verification under review' },
  blockers: [],
  kyc: { status: 'pending', tier: 1, sanctionsStatus: 'cleared' },
  wallet: {
    publicKey: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFDAGOROTMPGQW5BCW5AZ',
    funded: true,
    fundingState: 'succeeded',
    trustlineState: 'succeeded',
    network: 'testnet',
  },
  accountActive: true,
};

describe('OnboardingStatus - Stellar Address Copy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the 56-character Stellar public key in wallet state card', async () => {
    api.get.mockResolvedValueOnce({
      data: { success: true, data: mockStatusWithAddress },
    });

    render(<OnboardingStatus />);

    await waitFor(() => {
      expect(screen.getByTestId('stellar-address-value')).toBeInTheDocument();
    });

    const addressEl = screen.getByTestId('stellar-address-value');
    expect(addressEl.textContent).toBe('GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFDAGOROTMPGQW5BCW5AZ');
    expect(addressEl.textContent).toHaveLength(56);
  });

  it('copies full 56-character address to clipboard on button click', async () => {
    api.get.mockResolvedValueOnce({
      data: { success: true, data: mockStatusWithAddress },
    });

    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    });

    render(<OnboardingStatus />);

    await waitFor(() => {
      expect(screen.getByTestId('copy-address-button')).toBeInTheDocument();
    });

    const copyBtn = screen.getByTestId('copy-address-button');
    expect(copyBtn).toHaveAttribute('aria-label', 'Copy Stellar address to clipboard');

    await act(async () => {
      fireEvent.click(copyBtn);
    });

    expect(writeTextMock).toHaveBeenCalledTimes(1);
    expect(writeTextMock).toHaveBeenCalledWith('GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFDAGOROTMPGQW5BCW5AZ');
  });

  it('swaps icon to checkmark, shows tooltip, and announces via ARIA live region for 2 seconds', async () => {
    vi.useFakeTimers();

    api.get.mockResolvedValueOnce({
      data: { success: true, data: mockStatusWithAddress },
    });

    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    });

    render(<OnboardingStatus />);

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const copyBtn = screen.getByTestId('copy-address-button');
    const liveRegion = screen.getByTestId('copy-live-region');

    expect(screen.queryByTestId('copy-tooltip')).not.toBeInTheDocument();
    expect(liveRegion.textContent).toBe('');

    await act(async () => {
      fireEvent.click(copyBtn);
    });

    // Immediately after click
    expect(screen.getByTestId('copy-tooltip')).toBeInTheDocument();
    expect(screen.getByTestId('copy-tooltip').textContent).toBe('Copied to clipboard!');
    expect(copyBtn).toHaveAttribute('aria-label', 'Copied to clipboard!');
    expect(liveRegion.textContent).toBe('Copied to clipboard!');

    // Advance 1.9 seconds: should still be in copied state
    act(() => {
      vi.advanceTimersByTime(1900);
    });
    expect(screen.getByTestId('copy-tooltip')).toBeInTheDocument();
    expect(liveRegion.textContent).toBe('Copied to clipboard!');

    // Advance past 2 seconds (total 2000ms): should reset back
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(screen.queryByTestId('copy-tooltip')).not.toBeInTheDocument();
    expect(copyBtn).toHaveAttribute('aria-label', 'Copy Stellar address to clipboard');
    expect(liveRegion.textContent).toBe('');
  });

  it('falls back to document.execCommand when navigator.clipboard is unavailable', async () => {
    api.get.mockResolvedValueOnce({
      data: { success: true, data: mockStatusWithAddress },
    });

    // Remove clipboard API
    const originalClipboard = navigator.clipboard;
    Object.assign(navigator, { clipboard: undefined });

    const execCommandMock = vi.fn().mockReturnValue(true);
    document.execCommand = execCommandMock;

    render(<OnboardingStatus />);

    await waitFor(() => {
      expect(screen.getByTestId('copy-address-button')).toBeInTheDocument();
    });

    const copyBtn = screen.getByTestId('copy-address-button');

    await act(async () => {
      fireEvent.click(copyBtn);
    });

    expect(execCommandMock).toHaveBeenCalledWith('copy');
    expect(screen.getByTestId('copy-tooltip')).toBeInTheDocument();

    delete document.execCommand;
    Object.assign(navigator, { clipboard: originalClipboard });
  });

  it('renders fallback demo state address when API returns 401 unauthorized', async () => {
    const error401 = new Error('Unauthorized');
    error401.response = { status: 401 };
    api.get.mockRejectedValueOnce(error401);

    render(<OnboardingStatus />);

    await waitFor(() => {
      expect(screen.getByTestId('stellar-address-value')).toBeInTheDocument();
    });

    expect(screen.getByTestId('stellar-address-value').textContent).toBe(
      'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFDAGOROTMPGQW5BCW5AZ'
    );
  });
});
