import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
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

describe('OnboardingWizard identity document upload', () => {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  let urlCounter;

  beforeEach(() => {
    urlCounter = 0;
    URL.createObjectURL = vi.fn(() => `blob:mock-${++urlCounter}`);
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    // jsdom has neither function; restore to no-ops so the component's
    // unmount cleanup (which testing-library runs after this hook) still works.
    URL.createObjectURL = originalCreate ?? (() => '');
    URL.revokeObjectURL = originalRevoke ?? (() => {});
  });

  const makeFile = (name, type, size = 2048) => {
    const file = new File(['x'.repeat(16)], name, { type });
    Object.defineProperty(file, 'size', { value: size });
    return file;
  };

  it('previews a browsed image with name, size and a delete button', () => {
    render(<OnboardingWizard />);
    const input = screen.getByLabelText(/browse identity document files/i);

    fireEvent.change(input, { target: { files: [makeFile('passport.png', 'image/png', 150 * 1024)] } });

    expect(screen.getByRole('img', { name: /preview of passport\.png/i })).toHaveAttribute(
      'src',
      'blob:mock-1'
    );
    expect(screen.getByText('passport.png')).toBeInTheDocument();
    expect(screen.getByText('150.0 KB')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /remove passport\.png/i })).toBeInTheDocument();
  });

  it('accepts files dropped onto the dropzone and shows a PDF without an image preview', () => {
    render(<OnboardingWizard />);
    const dropzone = screen.getByTestId('id-doc-dropzone');

    fireEvent.drop(dropzone, {
      dataTransfer: { files: [makeFile('id-card.pdf', 'application/pdf', 1024 * 1024)] },
    });

    expect(screen.getByText('id-card.pdf')).toBeInTheDocument();
    expect(screen.getByText('1.0 MB')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /preview of id-card\.pdf/i })).not.toBeInTheDocument();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('ignores unsupported file types', () => {
    render(<OnboardingWizard />);
    const dropzone = screen.getByTestId('id-doc-dropzone');

    fireEvent.drop(dropzone, {
      dataTransfer: { files: [makeFile('malware.exe', 'application/x-msdownload')] },
    });

    expect(screen.queryByRole('list', { name: /uploaded identity documents/i })).not.toBeInTheDocument();
  });

  it('removes a document and releases its preview URL', () => {
    render(<OnboardingWizard />);
    const input = screen.getByLabelText(/browse identity document files/i);
    fireEvent.change(input, { target: { files: [makeFile('selfie.jpg', 'image/jpeg')] } });

    fireEvent.click(screen.getByRole('button', { name: /remove selfie\.jpg/i }));

    expect(screen.queryByText('selfie.jpg')).not.toBeInTheDocument();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-1');
  });

  it('exposes a camera capture input behind the Take Photo button', () => {
    render(<OnboardingWizard />);
    const cameraInput = screen.getByLabelText(/take a photo of your identity document/i);
    expect(cameraInput).toHaveAttribute('capture', 'environment');
    expect(cameraInput).toHaveAttribute('accept', 'image/*');

    fireEvent.change(cameraInput, { target: { files: [makeFile('camera.jpg', 'image/jpeg')] } });
    expect(screen.getByText('camera.jpg')).toBeInTheDocument();
  });

  it('caps uploads at three documents and disables the pickers', () => {
    render(<OnboardingWizard />);
    const input = screen.getByLabelText(/browse identity document files/i);
    const files = [1, 2, 3, 4].map((n) => makeFile(`doc-${n}.png`, 'image/png'));
    fireEvent.change(input, { target: { files } });

    expect(screen.getByText('doc-3.png')).toBeInTheDocument();
    expect(screen.queryByText('doc-4.png')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /browse files/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /take photo/i })).toBeDisabled();
  });
});
