import { render, screen, within, renderHook, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, afterEach, vi } from 'vitest';
import PasskeyPromptModal, { usePasskeyStepUp } from './PasskeyPromptModal';
import { installWebAuthnMock, uninstallWebAuthnMock } from '../test/passkeys';

const SUPPORTED = { supported: true, platformAuthenticator: true, checked: true };
const UNSUPPORTED = { supported: false, platformAuthenticator: false, checked: true };

afterEach(() => {
  uninstallWebAuthnMock();
});

const renderModal = (props = {}) =>
  render(
    <PasskeyPromptModal
      open
      action="user.deactivate"
      status="idle"
      error=""
      support={SUPPORTED}
      fallbackAcknowledged={false}
      onFallbackAcknowledgedChange={() => {}}
      onVerify={() => {}}
      onFallback={() => {}}
      onCancel={() => {}}
      {...props}
    />
  );

describe('PasskeyPromptModal', () => {
  it('renders nothing when closed', () => {
    renderModal({ open: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('explains the required step-up and runs the assertion on request', async () => {
    const onVerify = vi.fn();
    renderModal({ onVerify });

    const dialog = screen.getByRole('dialog', { name: /biometric step-up required/i });
    expect(within(dialog).getByText(/deactivate customer account/i)).toBeInTheDocument();
    expect(within(dialog).getAllByText(/touch id, face id, windows hello/i).length).toBeGreaterThan(0);

    await userEvent.click(within(dialog).getByRole('button', { name: /verify with passkey/i }));
    expect(onVerify).toHaveBeenCalledTimes(1);
  });

  it('announces the waiting state and blocks cancellation while verifying', async () => {
    const onCancel = vi.fn();
    const onVerify = vi.fn();
    renderModal({ status: 'verifying', onCancel, onVerify });

    const dialog = screen.getByRole('dialog', { name: /biometric step-up required/i });
    expect(dialog).toHaveAttribute('aria-busy', 'true');
    expect(within(dialog).getByRole('status')).toHaveTextContent(/waiting for your device/i);
    expect(within(dialog).getByRole('button', { name: /waiting for device/i })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: /cancel/i })).toBeDisabled();

    await userEvent.keyboard('{Escape}');
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('cancels on Escape when no verification is in flight', async () => {
    const onCancel = vi.fn();
    renderModal({ onCancel });

    await userEvent.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('surfaces the verification error as an alert', () => {
    renderModal({ status: 'error', error: 'Passkey verification was cancelled or timed out.' });

    expect(screen.getByRole('alert')).toHaveTextContent(/cancelled or timed out/i);
  });

  it('offers an acknowledged fallback when WebAuthn is unavailable', async () => {
    const onFallback = vi.fn();
    const onFallbackAcknowledgedChange = vi.fn();
    const { rerender } = renderModal({
      support: UNSUPPORTED,
      onFallback,
      onFallbackAcknowledgedChange,
    });

    const dialog = screen.getByRole('dialog', { name: /biometric step-up required/i });
    expect(within(dialog).getByText(/does not expose webauthn/i)).toBeInTheDocument();
    expect(
      within(dialog).queryByRole('button', { name: /verify with passkey/i })
    ).not.toBeInTheDocument();

    const continueButton = within(dialog).getByRole('button', { name: /continue without passkey/i });
    expect(continueButton).toBeDisabled();

    const checkbox = within(dialog).getByRole('checkbox');
    await userEvent.click(checkbox);
    expect(onFallbackAcknowledgedChange).toHaveBeenCalledWith(true);

    rerender(
      <PasskeyPromptModal
        open
        action="user.deactivate"
        support={UNSUPPORTED}
        fallbackAcknowledged
        onFallback={onFallback}
        onFallbackAcknowledgedChange={onFallbackAcknowledgedChange}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: /continue without passkey/i }));
    expect(onFallback).toHaveBeenCalledTimes(1);
  });
});

const renderStepUp = async (options) => {
  const view = renderHook(() => usePasskeyStepUp(options));
  // Flush the capability-detection promise before interacting.
  await act(async () => {});
  return view;
};

describe('usePasskeyStepUp', () => {
  it('invokes the mutation only after the passkey assertion succeeds', async () => {
    installWebAuthnMock();
    const onVerified = vi.fn();
    const { result } = await renderStepUp({ fetchChallenge: async () => ({ challenge: 'srv' }) });

    act(() => {
      result.current.startStepUp('user.deactivate', onVerified);
    });
    expect(result.current.isStepUpOpen).toBe(true);
    expect(onVerified).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.stepUpModalProps.onVerify();
    });

    expect(onVerified).toHaveBeenCalledTimes(1);
    const [payload] = onVerified.mock.calls[0];
    expect(payload.passkeyFallback).toBeNull();
    expect(payload.passkeyAssertion.response.signature).toBeTruthy();
    expect(payload.passkeyAssertion.response.clientDataJSON).toBeTruthy();
    expect(result.current.isStepUpOpen).toBe(false);
  });

  it('flags the operation when the operator continues without a passkey', async () => {
    const onVerified = vi.fn();
    const { result } = await renderStepUp({ fetchChallenge: async () => ({ challenge: 'srv' }) });

    act(() => {
      result.current.startStepUp('kyc.export', onVerified);
    });
    await act(async () => {
      await result.current.stepUpModalProps.onFallback();
    });

    expect(onVerified).toHaveBeenCalledWith({
      passkeyAssertion: null,
      passkeyFallback: 'unsupported_device',
    });
  });

  it('keeps the prompt open and reports a cancelled device prompt', async () => {
    installWebAuthnMock({
      getError: Object.assign(new Error('denied'), { name: 'NotAllowedError' }),
    });
    const onVerified = vi.fn();
    const { result } = await renderStepUp({ fetchChallenge: async () => ({ challenge: 'srv' }) });

    act(() => {
      result.current.startStepUp('user.deactivate', onVerified);
    });
    await act(async () => {
      await result.current.stepUpModalProps.onVerify();
    });

    expect(onVerified).not.toHaveBeenCalled();
    expect(result.current.isStepUpOpen).toBe(true);
    expect(result.current.stepUpModalProps.status).toBe('error');
    expect(result.current.stepUpModalProps.error).toMatch(/cancelled or timed out/i);
  });

  it('clears the error when the operator retries', async () => {
    installWebAuthnMock({
      getError: Object.assign(new Error('denied'), { name: 'NotAllowedError' }),
    });
    const onVerified = vi.fn();
    const { result } = await renderStepUp({ fetchChallenge: async () => ({ challenge: 'srv' }) });

    act(() => {
      result.current.startStepUp('user.deactivate', onVerified);
    });
    await act(async () => {
      await result.current.stepUpModalProps.onVerify();
    });
    expect(result.current.stepUpModalProps.error).not.toBe('');

    act(() => {
      result.current.stepUpModalProps.onCancel();
    });
    expect(result.current.isStepUpOpen).toBe(false);
    expect(result.current.stepUpModalProps.error).toBe('');
  });
});
