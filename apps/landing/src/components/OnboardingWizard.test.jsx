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
});
