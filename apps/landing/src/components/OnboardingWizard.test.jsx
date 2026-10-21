import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import OnboardingWizard from './OnboardingWizard.jsx';

describe('OnboardingWizard Component', () => {
  it('renders step 1 with phone input', () => {
    render(<OnboardingWizard />);
    expect(screen.getByText(/Experience 3-step onboarding in 60 seconds/i)).toBeInTheDocument();
    expect(screen.getByText(/Enter your WhatsApp phone number/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/WhatsApp Phone Number/i)).toBeInTheDocument();
  });

  it('allows user to advance to Step 2 (PIN) and Step 3 (Transfer)', async () => {
    render(<OnboardingWizard />);
    
    // Move to step 2
    const nextBtn = screen.getByRole('button', { name: /Next Step/i });
    fireEvent.click(nextBtn);
    expect(screen.getByText(/Set your 4-digit security PIN/i)).toBeInTheDocument();

    // Move to step 3
    fireEvent.click(screen.getByRole('button', { name: /Next Step/i }));
    expect(screen.getByText(/Simulate your first transfer/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Transfer Amount \(USDC\)/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Recipient Phone/i)).toBeInTheDocument();
  });

  it('allows user to navigate back via Back button', () => {
    render(<OnboardingWizard />);
    const nextBtn = screen.getByRole('button', { name: /Next Step/i });
    fireEvent.click(nextBtn);
    expect(screen.getByText(/Set your 4-digit security PIN/i)).toBeInTheDocument();

    const backBtn = screen.getByRole('button', { name: /Back/i });
    fireEvent.click(backBtn);
    expect(screen.getByText(/Enter your WhatsApp phone number/i)).toBeInTheDocument();
  });

  it('executes simulation and displays completion state with reset option', async () => {
    vi.useFakeTimers();
    render(<OnboardingWizard />);

    // Step 1 -> Step 2
    fireEvent.click(screen.getByRole('button', { name: /Next Step/i }));
    // Step 2 -> Step 3
    fireEvent.click(screen.getByRole('button', { name: /Next Step/i }));

    // Step 3 -> Execute simulation
    const executeBtn = screen.getByRole('button', { name: /Execute Simulation/i });
    fireEvent.click(executeBtn);

    act(() => {
      vi.advanceTimersByTime(1500);
    });

    expect(screen.getByText(/Simulated Onboarding & Transfer Complete!/i)).toBeInTheDocument();
    expect(screen.getByText(/Start Real Wallet on WhatsApp/i)).toBeInTheDocument();

    // Test reset
    const resetBtn = screen.getByRole('button', { name: /Reset Simulation/i });
    fireEvent.click(resetBtn);
    expect(screen.getByText(/Enter your WhatsApp phone number/i)).toBeInTheDocument();

    vi.useRealTimers();
  });

  it('debounces draft serialization to localStorage and excludes sensitive PIN fields', async () => {
    vi.useFakeTimers();
    localStorage.clear();
    render(<OnboardingWizard />);

    const phoneInput = screen.getByLabelText(/WhatsApp Phone Number/i);
    fireEvent.change(phoneInput, { target: { value: '+234 812 345 6789' } });

    // Step 1 -> Step 2
    fireEvent.click(screen.getByRole('button', { name: /Next Step/i }));

    // Input PIN digits
    const pin0 = screen.getAllByPlaceholderText('•')[0];
    fireEvent.change(pin0, { target: { value: '9' } });

    // Timer not advanced yet - debounced
    expect(localStorage.getItem('sendam_onboarding_draft_v1')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(500);
    });

    const savedRaw = localStorage.getItem('sendam_onboarding_draft_v1');
    expect(savedRaw).not.toBeNull();
    const saved = JSON.parse(savedRaw);

    expect(saved.phone).toBe('+234 812 345 6789');
    expect(saved.currentStep).toBe(2);
    // PIN must never be persisted
    expect(saved.pin).toBeUndefined();

    vi.useRealTimers();
    localStorage.clear();
  });

  it('restores draft state on mount and displays Resume your application banner', () => {
    localStorage.setItem(
      'sendam_onboarding_draft_v1',
      JSON.stringify({
        phone: '+234 999 888 7777',
        transferAmount: '150.00',
        recipient: '+233 555 444 3333',
        currentStep: 3,
      })
    );

    render(<OnboardingWizard />);

    expect(screen.getByTestId('resume-draft-banner')).toBeInTheDocument();
    expect(screen.getByText(/Resume your application:/i)).toBeInTheDocument();

    // Check that draft state is active on step 3
    expect(screen.getByLabelText(/Transfer Amount \(USDC\)/i)).toHaveValue('150.00');
    expect(screen.getByLabelText(/Recipient Phone/i)).toHaveValue('+233 555 444 3333');

    // Click Resume button to dismiss banner
    fireEvent.click(screen.getByRole('button', { name: /^Resume$/i }));
    expect(screen.queryByTestId('resume-draft-banner')).not.toBeInTheDocument();

    localStorage.clear();
  });

  it('discards draft and resets form when clear button is clicked', () => {
    localStorage.setItem(
      'sendam_onboarding_draft_v1',
      JSON.stringify({
        phone: '+234 999 888 7777',
        transferAmount: '150.00',
        recipient: '+233 555 444 3333',
        currentStep: 3,
      })
    );

    render(<OnboardingWizard />);
    expect(screen.getByTestId('resume-draft-banner')).toBeInTheDocument();

    // Click clear draft
    fireEvent.click(screen.getByRole('button', { name: /Clear draft/i }));

    expect(localStorage.getItem('sendam_onboarding_draft_v1')).toBeNull();
    expect(screen.queryByTestId('resume-draft-banner')).not.toBeInTheDocument();
    // Resets to step 1 with default phone
    expect(screen.getByLabelText(/WhatsApp Phone Number/i)).toHaveValue('+234 801 234 5678');

    localStorage.clear();
  });

  it('clears draft from localStorage when simulation completes', async () => {
    vi.useFakeTimers();
    localStorage.setItem(
      'sendam_onboarding_draft_v1',
      JSON.stringify({
        phone: '+234 999 888 7777',
        transferAmount: '150.00',
        recipient: '+233 555 444 3333',
        currentStep: 3,
      })
    );

    render(<OnboardingWizard />);
    const executeBtn = screen.getByRole('button', { name: /Execute Simulation/i });
    fireEvent.click(executeBtn);

    act(() => {
      vi.advanceTimersByTime(1500);
    });

    expect(screen.getByText(/Simulated Onboarding & Transfer Complete!/i)).toBeInTheDocument();
    expect(localStorage.getItem('sendam_onboarding_draft_v1')).toBeNull();

    vi.useRealTimers();
    localStorage.clear();
  });

  it('handles corrupted localStorage payload gracefully without throwing', () => {
    localStorage.setItem('sendam_onboarding_draft_v1', 'corrupted-json{');
    expect(() => render(<OnboardingWizard />)).not.toThrow();
    expect(screen.queryByTestId('resume-draft-banner')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/WhatsApp Phone Number/i)).toHaveValue('+234 801 234 5678');
    localStorage.clear();
  });
});
