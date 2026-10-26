import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
vi.mock('@/lib/imageCompression.js', () => ({ compressImageForUpload: vi.fn() }));
import { compressImageForUpload } from '@/lib/imageCompression.js';
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

describe('OnboardingWizard identity document upload', () => {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  let urlCounter;

  beforeEach(() => {
    urlCounter = 0;
    URL.createObjectURL = vi.fn(() => `blob:mock-${++urlCounter}`);
    URL.revokeObjectURL = vi.fn();
    compressImageForUpload.mockReset();
    compressImageForUpload.mockResolvedValue(new Blob([new Uint8Array(1024)], { type: 'image/jpeg' }));
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

  it('compresses a chosen photo, shows progress, then reports it is ready', async () => {
    compressImageForUpload.mockImplementation(async (_file, { onProgress }) => {
      onProgress(40);
      return new Blob([new Uint8Array(512 * 1024)], { type: 'image/jpeg' });
    });
    render(<OnboardingWizard />);

    const input = screen.getByLabelText(/browse identity document files/i);
    const photo = makeFile('id.jpg', 'image/jpeg');
    fireEvent.change(input, { target: { files: [photo] } });

    expect(compressImageForUpload).toHaveBeenCalledWith(photo, expect.objectContaining({ onProgress: expect.any(Function) }));
    expect(await screen.findByRole('status')).toHaveTextContent('Photo ready to upload (512 KB)');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('shows the compression progress bar while the photo is being processed', async () => {
    let finish;
    compressImageForUpload.mockImplementation(
      (_file, { onProgress }) =>
        new Promise((resolve) => {
          onProgress(35);
          finish = () => resolve(new Blob([new Uint8Array(1024)]));
        }),
    );
    render(<OnboardingWizard />);

    fireEvent.change(screen.getByLabelText(/browse identity document files/i), {
      target: { files: [makeFile('id.jpg', 'image/jpeg')] },
    });

    const bar = await screen.findByRole('progressbar', { name: /compressing identity photo/i });
    expect(bar).toHaveAttribute('aria-valuenow', '35');

    await act(async () => finish());
    expect(await screen.findByRole('status')).toHaveTextContent('Photo ready to upload');
  });

  it('surfaces a compression failure to the visitor', async () => {
    compressImageForUpload.mockRejectedValue(new Error('Please choose a photo file.'));
    render(<OnboardingWizard />);

    fireEvent.change(screen.getByLabelText(/browse identity document files/i), {
      target: { files: [makeFile('scan.png', 'image/png')] },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('Please choose a photo file.');
  });

  it('does not compress PDFs', () => {
    render(<OnboardingWizard />);

    fireEvent.drop(screen.getByTestId('id-doc-dropzone'), {
      dataTransfer: { files: [makeFile('id-card.pdf', 'application/pdf')] },
    });

    expect(screen.getByText('id-card.pdf')).toBeInTheDocument();
    expect(compressImageForUpload).not.toHaveBeenCalled();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
});
