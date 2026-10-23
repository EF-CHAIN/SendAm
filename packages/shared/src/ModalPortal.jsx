import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';

/**
 * Module-level state tracking for body scroll locks across multiple/nested modals.
 * Prevents premature unlock and layout shift when multiple modals are mounted.
 */
let openModalCount = 0;
let originalOverflow = '';
let originalPaddingRight = '';

function lockBodyScroll() {
  if (typeof document === 'undefined') return;

  if (openModalCount === 0) {
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    originalOverflow = document.body.style.overflow;
    originalPaddingRight = document.body.style.paddingRight;

    document.body.style.overflow = 'hidden';
    if (scrollbarWidth > 0) {
      document.body.style.paddingRight = `${scrollbarWidth}px`;
    }
  }
  openModalCount += 1;
}

function unlockBodyScroll() {
  if (typeof document === 'undefined') return;

  openModalCount = Math.max(0, openModalCount - 1);
  if (openModalCount === 0) {
    document.body.style.overflow = originalOverflow;
    document.body.style.paddingRight = originalPaddingRight;
  }
}

/**
 * Ensures the portal root element (#modal-root by default) exists in the document.
 */
function getOrCreateModalRoot(rootId = 'modal-root') {
  if (typeof document === 'undefined') return null;

  let rootElement = document.getElementById(rootId);
  if (!rootElement) {
    rootElement = document.createElement('div');
    rootElement.id = rootId;
    document.body.appendChild(rootElement);
  }
  return rootElement;
}

/**
 * ModalPortal — Accessible modal backdrop portal component in packages/shared.
 *
 * Acceptance Criteria:
 * - Mounts at document root via React createPortal rendering to #modal-root
 * - Automatically locks document.body scroll without layout shift
 * - Unlocks cleanly on unmount or when closed
 * - Full keyboard containment (Tab trap) and Escape-to-close accessibility
 */
export default function ModalPortal({
  isOpen = true,
  onClose,
  children,
  closeOnEsc = true,
  closeOnBackdropClick = true,
  role = 'dialog',
  ariaLabel,
  ariaLabelledBy,
  ariaDescribedBy,
  backdropClassName = 'bg-black/50',
  className = '',
  rootId = 'modal-root',
}) {
  const [mountNode, setMountNode] = useState(null);
  const modalContentRef = useRef(null);
  const previousFocusedElementRef = useRef(null);
  const isLockedRef = useRef(false);

  // Initialize portal mount node
  useEffect(() => {
    const node = getOrCreateModalRoot(rootId);
    setMountNode(node);
  }, [rootId]);

  // Lock and unlock body scroll
  useEffect(() => {
    if (isOpen) {
      if (!isLockedRef.current) {
        lockBodyScroll();
        isLockedRef.current = true;
      }
    } else if (isLockedRef.current) {
      unlockBodyScroll();
      isLockedRef.current = false;
    }

    return () => {
      if (isLockedRef.current) {
        unlockBodyScroll();
        isLockedRef.current = false;
      }
    };
  }, [isOpen]);

  // Manage focus trap and restoration
  useEffect(() => {
    if (!isOpen) return;

    if (typeof document !== 'undefined') {
      previousFocusedElementRef.current = document.activeElement;
    }

    // Move focus inside the dialog upon opening
    const timer = setTimeout(() => {
      if (!modalContentRef.current) return;
      const focusableElements = modalContentRef.current.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusableElements.length > 0) {
        focusableElements[0].focus();
      } else {
        modalContentRef.current.focus();
      }
    }, 0);

    return () => {
      clearTimeout(timer);
      if (
        previousFocusedElementRef.current &&
        typeof previousFocusedElementRef.current.focus === 'function'
      ) {
        try {
          previousFocusedElementRef.current.focus();
        } catch {
          // Ignore focus restore errors if element was removed
        }
      }
    };
  }, [isOpen]);

  // Handle Escape key and Tab focus trapping
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event) => {
      if (event.key === 'Escape' && closeOnEsc) {
        event.stopPropagation();
        if (typeof onClose === 'function') {
          onClose();
        }
        return;
      }

      if (event.key === 'Tab' && modalContentRef.current) {
        const focusable = modalContentRef.current.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) {
          event.preventDefault();
          return;
        }

        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, closeOnEsc, onClose]);

  const handleBackdropClick = useCallback(
    (event) => {
      if (event.target === event.currentTarget && closeOnBackdropClick) {
        if (typeof onClose === 'function') {
          onClose();
        }
      }
    },
    [closeOnBackdropClick, onClose]
  );

  if (!isOpen || !mountNode) {
    return null;
  }

  const modalNode = (
    <div
      role="presentation"
      data-testid="modal-backdrop"
      onClick={handleBackdropClick}
      className={`fixed inset-0 z-50 flex items-center justify-center p-4 transition-opacity duration-200 ${backdropClassName}`}
    >
      <div
        ref={modalContentRef}
        role={role}
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={ariaDescribedBy}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={`relative z-10 max-h-[90vh] overflow-y-auto outline-none ${className}`}
      >
        {children}
      </div>
    </div>
  );

  return createPortal(modalNode, mountNode);
}
