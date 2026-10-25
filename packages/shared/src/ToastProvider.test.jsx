import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import ToastProvider, { useToast } from './ToastProvider.jsx';

function TestConsumer({ onMount }) {
  const toastContext = useToast();
  React.useEffect(() => {
    if (onMount) onMount(toastContext);
  }, [onMount, toastContext]);

  return (
    <div>
      <button onClick={() => toastContext.toast.success('Operation succeeded')}>
        Trigger Success
      </button>
      <button onClick={() => toastContext.toast.error('Something went wrong')}>
        Trigger Error
      </button>
      <button onClick={() => toastContext.toast.warning('Check inputs')}>
        Trigger Warning
      </button>
      <button onClick={() => toastContext.toast.info('New info available')}>
        Trigger Info
      </button>
      <button
        onClick={() =>
          toastContext.addToast({
            title: 'Custom Title',
            message: 'Custom message body',
            duration: 1000,
          })
        }
      >
        Trigger Custom
      </button>
    </div>
  );
}

describe('ToastProvider & useToast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws an error if useToast is invoked outside ToastProvider', () => {
    // Suppress console.error in React for expected boundary error
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<TestConsumer />)).toThrow(
      'useToast must be used within a ToastProvider'
    );
    spy.mockRestore();
  });

  it('renders children properly inside provider', () => {
    render(
      <ToastProvider>
        <span data-testid="child">Child content</span>
      </ToastProvider>
    );
    expect(screen.getByTestId('child')).toBeDefined();
    expect(screen.getByRole('region', { name: /notifications/i })).toBeDefined();
  });

  it('adds and renders a success toast with accessible polite status', () => {
    render(
      <ToastProvider>
        <TestConsumer />
      </ToastProvider>
    );

    act(() => {
      fireEvent.click(screen.getByText('Trigger Success'));
    });

    const toast = screen.getByRole('status');
    expect(toast).toBeDefined();
    expect(toast.textContent).toContain('Operation succeeded');
    expect(toast.getAttribute('aria-live')).toBe('polite');
    expect(toast.getAttribute('data-toast-type')).toBe('success');
  });

  it('adds and renders an error toast with assertive alert role', () => {
    render(
      <ToastProvider>
        <TestConsumer />
      </ToastProvider>
    );

    act(() => {
      fireEvent.click(screen.getByText('Trigger Error'));
    });

    const alert = screen.getByRole('alert');
    expect(alert).toBeDefined();
    expect(alert.textContent).toContain('Something went wrong');
    expect(alert.getAttribute('aria-live')).toBe('assertive');
    expect(alert.getAttribute('data-toast-type')).toBe('error');
  });

  it('renders warning and info toasts properly', () => {
    render(
      <ToastProvider>
        <TestConsumer />
      </ToastProvider>
    );

    act(() => {
      fireEvent.click(screen.getByText('Trigger Warning'));
      fireEvent.click(screen.getByText('Trigger Info'));
    });

    expect(screen.getByText('Check inputs')).toBeDefined();
    expect(screen.getByText('New info available')).toBeDefined();
  });

  it('stacks multiple toasts gracefully in bottom-right region', () => {
    render(
      <ToastProvider>
        <TestConsumer />
      </ToastProvider>
    );

    act(() => {
      fireEvent.click(screen.getByText('Trigger Success'));
      fireEvent.click(screen.getByText('Trigger Warning'));
    });

    const region = screen.getByRole('region', { name: /notifications/i });
    expect(region).toBeDefined();
    expect(region.className).toContain('fixed');
    expect(region.className).toContain('bottom-4');
    expect(region.className).toContain('right-4');

    const toastCards = region.querySelectorAll('[data-toast-id]');
    expect(toastCards.length).toBe(2);
  });

  it('automatically dismisses after 4000ms by default with smooth exit animation', () => {
    render(
      <ToastProvider>
        <TestConsumer />
      </ToastProvider>
    );

    act(() => {
      fireEvent.click(screen.getByText('Trigger Success'));
    });

    const toast = screen.getByRole('status');
    expect(toast).toBeDefined();
    expect(toast.className).toContain('opacity-100');

    // Advance 4000ms to trigger dismiss exit animation
    act(() => {
      vi.advanceTimersByTime(4000);
    });

    // It should now have exiting styling
    expect(toast.className).toContain('opacity-0');

    // Advance exit transition duration (300ms)
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(screen.queryByRole('status')).toBeNull();
  });

  it('dismisses immediately when clicking the toast card', () => {
    render(
      <ToastProvider>
        <TestConsumer />
      </ToastProvider>
    );

    act(() => {
      fireEvent.click(screen.getByText('Trigger Success'));
    });

    const toast = screen.getByRole('status');
    expect(toast).toBeDefined();

    // Click on the toast card
    act(() => {
      fireEvent.click(toast);
    });

    // Exit animation starts
    expect(toast.className).toContain('opacity-0');

    // Complete exit transition
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(screen.queryByRole('status')).toBeNull();
  });

  it('dismisses via the close button without triggering card click twice', () => {
    render(
      <ToastProvider>
        <TestConsumer />
      </ToastProvider>
    );

    act(() => {
      fireEvent.click(screen.getByText('Trigger Success'));
    });

    const closeBtn = screen.getByLabelText('Dismiss notification');
    expect(closeBtn).toBeDefined();

    act(() => {
      fireEvent.click(closeBtn);
    });

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(screen.queryByRole('status')).toBeNull();
  });

  it('respects custom durations and renders titles', () => {
    render(
      <ToastProvider>
        <TestConsumer />
      </ToastProvider>
    );

    act(() => {
      fireEvent.click(screen.getByText('Trigger Custom'));
    });

    expect(screen.getByText('Custom Title')).toBeDefined();
    expect(screen.getByText('Custom message body')).toBeDefined();

    // Advance 900ms: still visible
    act(() => {
      vi.advanceTimersByTime(900);
    });
    expect(screen.getByText('Custom Title')).toBeDefined();

    // Advance remaining 100ms + 300ms exit
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.queryByText('Custom Title')).toBeNull();
  });

  it('supports programmatic toast.dismiss(id) and clear()', () => {
    let helpers;
    render(
      <ToastProvider>
        <TestConsumer
          onMount={(ctx) => {
            helpers = ctx;
          }}
        />
      </ToastProvider>
    );

    let id1;
    act(() => {
      id1 = helpers.toast.info('Message 1', { duration: 0 }); // infinite
      helpers.toast.info('Message 2', { duration: 0 });
    });

    expect(screen.getByText('Message 1')).toBeDefined();
    expect(screen.getByText('Message 2')).toBeDefined();

    // Dismiss first toast
    act(() => {
      helpers.toast.dismiss(id1);
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(screen.queryByText('Message 1')).toBeNull();
    expect(screen.getByText('Message 2')).toBeDefined();

    // Clear all
    act(() => {
      helpers.toast.clear();
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(screen.queryByText('Message 2')).toBeNull();
  });
});
