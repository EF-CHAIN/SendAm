import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import KycReview from './KycReview';
import KycImageCompareModal from '../components/KycImageCompareModal';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { installWebAuthnMock, uninstallWebAuthnMock } from '../test/passkeys';

const renderKyc = () =>
  render(
    <MemoryRouter>
      <KycReview />
    </MemoryRouter>
  );

const waitForTable = async () => {
  await waitFor(() => {
    expect(screen.getByRole('table')).toBeInTheDocument();
  });
};

describe('KycImageCompareModal & KycReview Document Comparison (#759)', () => {
  beforeEach(() => {
    installWebAuthnMock();
  });

  afterEach(() => {
    uninstallWebAuthnMock();
  });

  const mockRecord = {
    _id: 'kyc_sample_123',
    userId: { phoneNumber: '+2348012345678' },
    provider: 'Smile ID',
    tier: 'Tier 2',
    riskScore: 'Low',
    status: 'pending',
    documentUrl: 'https://example.com/passport.jpg',
    selfieUrl: 'https://example.com/selfie.jpg',
  };

  it('renders a Compare button in the actions column of KycReview', async () => {
    renderKyc();
    await waitForTable();

    const compareBtn = screen.getByTestId('compare-btn-kyc1');
    expect(compareBtn).toBeInTheDocument();
    expect(compareBtn).toHaveTextContent(/compare/i);
  });

  it('opens side-by-side comparison modal when Compare button is clicked', async () => {
    renderKyc();
    await waitForTable();

    const compareBtn = screen.getByTestId('compare-btn-kyc1');
    await userEvent.click(compareBtn);

    const dialog = await screen.findByRole('dialog', { name: /document vs selfie/i });
    expect(dialog).toBeInTheDocument();

    // Check header info
    expect(within(dialog).getByText('+1234567890')).toBeInTheDocument();
    expect(within(dialog).getByText(/Onfido/i)).toBeInTheDocument();

    // Both panels are rendered
    expect(within(dialog).getByTestId('doc-viewport')).toBeInTheDocument();
    expect(within(dialog).getByTestId('selfie-viewport')).toBeInTheDocument();
    expect(within(dialog).getByTestId('doc-image')).toBeInTheDocument();
    expect(within(dialog).getByTestId('selfie-image')).toBeInTheDocument();
  });

  it('closes the comparison modal when clicking close or pressing Escape', async () => {
    renderKyc();
    await waitForTable();

    await userEvent.click(screen.getByTestId('compare-btn-kyc1'));
    const dialog = await screen.findByRole('dialog', { name: /document vs selfie/i });

    // Close button
    const closeBtn = within(dialog).getByTestId('close-compare-modal');
    await userEvent.click(closeBtn);

    expect(screen.queryByRole('dialog', { name: /document vs selfie/i })).not.toBeInTheDocument();

    // Open again and close with Escape
    await userEvent.click(screen.getByTestId('compare-btn-kyc1'));
    expect(await screen.findByRole('dialog', { name: /document vs selfie/i })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: /document vs selfie/i })).not.toBeInTheDocument();
  });

  it('supports synchronized zoom controls across both panes', async () => {
    const onClose = vi.fn();
    render(
      <KycImageCompareModal
        isOpen={true}
        onClose={onClose}
        record={mockRecord}
      />
    );

    // Initial percentage is 100% on both panes
    expect(screen.getByTestId('doc-zoom-level')).toHaveTextContent('100%');
    expect(screen.getByTestId('selfie-zoom-level')).toHaveTextContent('100%');

    const docZoomIn = screen.getByTestId('doc-zoom-in');
    await userEvent.click(docZoomIn);

    // With syncZoom ON (default), both doc and selfie zoom to 120%
    expect(screen.getByTestId('doc-zoom-level')).toHaveTextContent('120%');
    expect(screen.getByTestId('selfie-zoom-level')).toHaveTextContent('120%');

    // Zoom out
    const docZoomOut = screen.getByTestId('doc-zoom-out');
    await userEvent.click(docZoomOut);
    expect(screen.getByTestId('doc-zoom-level')).toHaveTextContent('100%');
    expect(screen.getByTestId('selfie-zoom-level')).toHaveTextContent('100%');

    // Toggle sync zoom OFF
    const syncToggle = screen.getByTestId('toggle-sync-zoom');
    await userEvent.click(syncToggle);
    expect(syncToggle).toHaveTextContent(/sync zoom: off/i);

    // Zooming doc only zooms doc pane
    await userEvent.click(docZoomIn);
    expect(screen.getByTestId('doc-zoom-level')).toHaveTextContent('120%');
    expect(screen.getByTestId('selfie-zoom-level')).toHaveTextContent('100%');
  });

  it('supports 90-degree image rotation per pane', async () => {
    render(
      <KycImageCompareModal
        isOpen={true}
        onClose={vi.fn()}
        record={mockRecord}
      />
    );

    const docRotate = screen.getByTestId('doc-rotate');
    const docImgWrapper = screen.getByTestId('doc-image').parentElement;
    expect(docImgWrapper.style.transform).toContain('rotate(0deg)');

    await userEvent.click(docRotate);
    expect(docImgWrapper.style.transform).toContain('rotate(90deg)');

    await userEvent.click(docRotate);
    expect(docImgWrapper.style.transform).toContain('rotate(180deg)');

    // Reset doc pane
    const docReset = screen.getByTestId('doc-reset');
    await userEvent.click(docReset);
    expect(docImgWrapper.style.transform).toContain('rotate(0deg)');
  });

  it('supports mousewheel zoom and dragging on viewports', async () => {
    render(
      <KycImageCompareModal
        isOpen={true}
        onClose={vi.fn()}
        record={mockRecord}
      />
    );

    const docViewport = screen.getByTestId('doc-viewport');
    const docImgWrapper = screen.getByTestId('doc-image').parentElement;

    // Mouse wheel up zooms in
    fireEvent.wheel(docViewport, { deltaY: -100 });
    expect(docImgWrapper.style.transform).toContain('scale(1.2)');

    // Mouse wheel down zooms out
    fireEvent.wheel(docViewport, { deltaY: 100 });
    expect(docImgWrapper.style.transform).toContain('scale(1)');

    // Drag-to-pan simulation
    fireEvent.mouseDown(docViewport, { clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { clientX: 150, clientY: 130 });
    fireEvent.mouseUp(window);

    expect(docImgWrapper.style.transform).toContain('translate(50px, 30px)');

    // Reset all views restores 0px pan and 1x zoom
    const resetAllBtn = screen.getByTestId('reset-all-views');
    await userEvent.click(resetAllBtn);
    expect(docImgWrapper.style.transform).toContain('translate(0px, 0px)');
    expect(docImgWrapper.style.transform).toContain('scale(1)');
  });

  it('supports brightness and contrast slider adjustments', async () => {
    render(
      <KycImageCompareModal
        isOpen={true}
        onClose={vi.fn()}
        record={mockRecord}
      />
    );

    const brightnessSlider = screen.getByLabelText(/Document Brightness/i);
    const contrastSlider = screen.getByLabelText(/Document Contrast/i);
    const docImgWrapper = screen.getByTestId('doc-image').parentElement;

    fireEvent.change(brightnessSlider, { target: { value: '140' } });
    fireEvent.change(contrastSlider, { target: { value: '120' } });

    expect(docImgWrapper.style.filter).toContain('brightness(140%)');
    expect(docImgWrapper.style.filter).toContain('contrast(120%)');
  });

  it('allows approving directly from the comparison modal', async () => {
    renderKyc();
    await waitForTable();

    await userEvent.click(screen.getByTestId('compare-btn-kyc1'));
    const compareDialog = await screen.findByRole('dialog', { name: /document vs selfie/i });

    const approveBtn = within(compareDialog).getByTestId('compare-modal-approve-btn');
    await userEvent.click(approveBtn);

    // Modal closes and opens the confirmation modal for approval
    expect(screen.queryByRole('dialog', { name: /document vs selfie/i })).not.toBeInTheDocument();
    const confirmDialog = await screen.findByRole('dialog', { name: /approve kyc/i });
    expect(confirmDialog).toBeInTheDocument();
  });

  it('allows rejecting directly from the comparison modal', async () => {
    renderKyc();
    await waitForTable();

    await userEvent.click(screen.getByTestId('compare-btn-kyc1'));
    const compareDialog = await screen.findByRole('dialog', { name: /document vs selfie/i });

    const rejectBtn = within(compareDialog).getByTestId('compare-modal-reject-btn');
    await userEvent.click(rejectBtn);

    // Modal closes and opens the confirmation modal for rejection
    expect(screen.queryByRole('dialog', { name: /document vs selfie/i })).not.toBeInTheDocument();
    const confirmDialog = await screen.findByRole('dialog', { name: /reject kyc/i });
    expect(confirmDialog).toBeInTheDocument();
  });
});
