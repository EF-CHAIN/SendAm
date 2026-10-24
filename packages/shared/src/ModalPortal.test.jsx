import React, { useState } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import ModalPortal from './ModalPortal.jsx';

describe('ModalPortal', () => {
  let triggerButton;

  beforeEach(() => {
    // Reset body style and DOM
    document.body.style.overflow = '';
    document.body.style.paddingRight = '';
    const existingRoot = document.getElementById('modal-root');
    if (existingRoot) {
      existingRoot.remove();
    }

    triggerButton = document.createElement('button');
    triggerButton.textContent = 'Open Trigger';
    document.body.appendChild(triggerButton);
    triggerButton.focus();
  });

  afterEach(() => {
    triggerButton.remove();
    const modalRoot = document.getElementById('modal-root');
    if (modalRoot) {
      modalRoot.remove();
    }
    document.body.style.overflow = '';
    document.body.style.paddingRight = '';
  });

  it('automatically creates #modal-root and mounts portal at document root', () => {
    expect(document.getElementById('modal-root')).toBeNull();

    render(
      <ModalPortal isOpen={true} ariaLabel="Test Modal">
        <div data-testid="modal-content">Hello Modal</div>
      </ModalPortal>
    );

    const modalRoot = document.getElementById('modal-root');
    expect(modalRoot).not.toBeNull();
    expect(modalRoot.parentNode).toBe(document.body);

    const content = screen.getByTestId('modal-content');
    expect(modalRoot.contains(content)).toBe(true);
  });

  it('renders nothing and does not lock body scroll when isOpen is false', () => {
    render(
      <ModalPortal isOpen={false}>
        <div data-testid="modal-content">Hidden</div>
      </ModalPortal>
    );

    expect(screen.queryByTestId('modal-content')).toBeNull();
    expect(document.body.style.overflow).toBe('');
  });

  it('locks body scroll when open and unlocks cleanly on unmount', () => {
    const { unmount } = render(
      <ModalPortal isOpen={true}>
        <div>Active Modal</div>
      </ModalPortal>
    );

    expect(document.body.style.overflow).toBe('hidden');

    unmount();

    expect(document.body.style.overflow).toBe('');
  });

  it('locks body scroll without layout shift by applying scrollbar width padding', () => {
    // Mock scrollbar width calculation
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
    Object.defineProperty(document.documentElement, 'clientWidth', { value: 1008, configurable: true });
    // Scrollbar width is 1024 - 1008 = 16px

    const { unmount } = render(
      <ModalPortal isOpen={true}>
        <div>Modal Content</div>
      </ModalPortal>
    );

    expect(document.body.style.overflow).toBe('hidden');
    expect(document.body.style.paddingRight).toBe('16px');

    unmount();

    expect(document.body.style.overflow).toBe('');
    expect(document.body.style.paddingRight).toBe('');
  });

  it('handles multiple open modals without premature unlock', () => {
    function MultiModalWrapper() {
      const [firstOpen, setFirstOpen] = useState(true);
      const [secondOpen, setSecondOpen] = useState(true);

      return (
        <>
          <button onClick={() => setFirstOpen(false)}>Close First</button>
          <button onClick={() => setSecondOpen(false)}>Close Second</button>
          <ModalPortal isOpen={firstOpen}>
            <div>First Modal</div>
          </ModalPortal>
          <ModalPortal isOpen={secondOpen}>
            <div>Second Modal</div>
          </ModalPortal>
        </>
      );
    }

    render(<MultiModalWrapper />);
    expect(document.body.style.overflow).toBe('hidden');

    // Close first modal: body should still remain locked
    fireEvent.click(screen.getByText('Close First'));
    expect(document.body.style.overflow).toBe('hidden');

    // Close second modal: body should now unlock cleanly
    fireEvent.click(screen.getByText('Close Second'));
    expect(document.body.style.overflow).toBe('');
  });

  it('calls onClose when Escape key is pressed', () => {
    const onClose = vi.fn();
    render(
      <ModalPortal isOpen={true} onClose={onClose}>
        <div>Modal Content</div>
      </ModalPortal>
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not call onClose on Escape if closeOnEsc is false', () => {
    const onClose = vi.fn();
    render(
      <ModalPortal isOpen={true} onClose={onClose} closeOnEsc={false}>
        <div>Modal Content</div>
      </ModalPortal>
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('calls onClose when backdrop is clicked, but not when modal content is clicked', () => {
    const onClose = vi.fn();
    render(
      <ModalPortal isOpen={true} onClose={onClose}>
        <div data-testid="inner-content">
          <p>Inner text</p>
        </div>
      </ModalPortal>
    );

    // Click inside content: should not trigger onClose
    fireEvent.click(screen.getByTestId('inner-content'));
    expect(onClose).not.toHaveBeenCalled();

    // Click backdrop
    const backdrop = screen.getByTestId('modal-backdrop');
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close on backdrop click if closeOnBackdropClick is false', () => {
    const onClose = vi.fn();
    render(
      <ModalPortal isOpen={true} onClose={onClose} closeOnBackdropClick={false}>
        <div>Content</div>
      </ModalPortal>
    );

    fireEvent.click(screen.getByTestId('modal-backdrop'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('traps Tab focus inside the modal dialog', async () => {
    render(
      <ModalPortal isOpen={true}>
        <button data-testid="first-btn">First</button>
        <button data-testid="last-btn">Last</button>
      </ModalPortal>
    );

    const firstBtn = screen.getByTestId('first-btn');
    const lastBtn = screen.getByTestId('last-btn');

    // Focus last button and press Tab -> should cycle to first button
    lastBtn.focus();
    expect(document.activeElement).toBe(lastBtn);

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: false });
    expect(document.activeElement).toBe(firstBtn);

    // Focus first button and press Shift+Tab -> should cycle to last button
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(lastBtn);
  });

  it('restores focus to previously active element on unmount', () => {
    triggerButton.focus();
    expect(document.activeElement).toBe(triggerButton);

    const { unmount } = render(
      <ModalPortal isOpen={true}>
        <button>Inside Modal</button>
      </ModalPortal>
    );

    unmount();
    expect(document.activeElement).toBe(triggerButton);
  });

  it('applies proper accessibility roles and aria attributes', () => {
    render(
      <ModalPortal
        isOpen={true}
        role="alertdialog"
        ariaLabel="Confirm Action"
        ariaDescribedBy="modal-desc"
      >
        <p id="modal-desc">Are you sure?</p>
      </ModalPortal>
    );

    const dialog = screen.getByRole('alertdialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe('Confirm Action');
    expect(dialog.getAttribute('aria-describedby')).toBe('modal-desc');
  });
});
