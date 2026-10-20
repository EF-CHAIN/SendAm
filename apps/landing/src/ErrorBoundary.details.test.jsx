import { createRef } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from './test/axe.js';
import ErrorBoundary from '@shared/ErrorBoundary.jsx';

function Crash({ error }) { throw error; }

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function expand(user) {
  await user.click(screen.getByText('Technical Details'));
  return screen.findByLabelText('Error details');
}

describe('ErrorBoundary support details', () => {
  it.each(['landing', 'admin'])('copies name, message, both stacks and user agent in %s', async (variant) => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const error = new TypeError('Unable to render the balance');
    error.stack = 'TypeError: Unable to render the balance\n    at Balance (https://example.test/assets/app.js?token=hidden:12:3)';
    render(<ErrorBoundary variant={variant}><Crash error={error} /></ErrorBoundary>);

    expect(screen.getByText('Technical Details').closest('details')).not.toHaveAttribute('open');
    expect(screen.queryByLabelText('Error details')).not.toBeInTheDocument();
    const details = await expand(user);
    expect(details).toHaveTextContent('Error name: TypeError');
    expect(details).toHaveTextContent('Component stack:');
    expect(details).toHaveTextContent('Crash');
    await user.click(screen.getByRole('button', { name: 'Copy Error Details' }));
    expect(writeText).toHaveBeenCalledWith(details.textContent);
    const report = writeText.mock.calls[0][0];
    expect(report).toContain('Message: Unable to render the balance');
    expect(report).toContain('Stack:\nTypeError: Unable to render the balance');
    expect(report).toContain(`Browser user agent: ${navigator.userAgent}`);
    expect(report).not.toContain('example.test');
    expect(report).not.toContain('token=hidden');
    expect(await screen.findByRole('status')).toHaveTextContent('Error details copied.');
    await user.click(screen.getByText('Technical Details'));
    await waitFor(() => expect(screen.queryByLabelText('Error details')).not.toBeInTheDocument());
  });

  it('redacts secrets and private paths from displayed and copied diagnostics', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const error = new Error('Failed password="private words" token=hidden-value contact alice@example.test');
    error.stack = `Error: ${error.message}\n at Balance (C:\\Users\\Alice Smith\\project\\Balance.jsx:12:3)\nAuthorization: Bearer secret-header\n at Widget (/home/alice/project/Widget.jsx:5:1)`;
    const ref = createRef();
    render(<ErrorBoundary ref={ref}><Crash error={error} /></ErrorBoundary>);
    act(() => ref.current.componentDidCatch(error, {
      componentStack: '\n at Balance (https://user:private@example.test/a.jsx?key=hidden#private)\n at App (/home/alice/app.jsx:4:5)',
    }));
    const details = await expand(user);
    await user.click(screen.getByRole('button', { name: 'Copy Error Details' }));
    expect(writeText).toHaveBeenCalledWith(details.textContent);
    for (const secret of ['private words', 'hidden-value', 'alice@example.test', 'Alice Smith', 'secret-header', '/home/alice', 'example.test', '?key=hidden']) {
      expect(details.textContent).not.toContain(secret);
    }
    expect(details.textContent).toContain('[REDACTED]');
    expect(details.textContent).toContain('at Balance');
  });

  it('renders diagnostic markup as text without injecting HTML', async () => {
    const user = userEvent.setup();
    render(<ErrorBoundary><Crash error={new Error('<img src=x onerror=alert(1)>')} /></ErrorBoundary>);
    const details = await expand(user);
    expect(details.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(details.querySelector('img')).toBeNull();
  });

  it('redacts standalone key formats and bounds long diagnostic fields', async () => {
    const user = userEvent.setup();
    const seedFixture = `S${'A'.repeat(55)}`;
    const jwtFixture = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJmaXh0dXJlIn0.fixture';
    // Assemble synthetic markers so secret scanners do not mistake the test
    // fixture for an actual committed private key.
    const keyType = 'PRIVATE KEY';
    const error = new Error(`${seedFixture} ${jwtFixture}\n-----BEGIN ${keyType}-----\nfixture-only\n-----END ${keyType}-----`);
    error.stack = 'x'.repeat(10000);
    render(<ErrorBoundary><Crash error={error} /></ErrorBoundary>);
    const details = await expand(user);
    expect(details.textContent).not.toContain(seedFixture);
    expect(details.textContent).not.toContain(jwtFixture);
    expect(details.textContent).not.toContain('fixture-only');
    expect(details.textContent).toContain('x'.repeat(6000));
    expect(details.textContent).not.toContain('x'.repeat(6001));
  });

  it('has no detected accessibility violations when the native disclosure is open', async () => {
    const user = userEvent.setup();
    const { container } = render(<ErrorBoundary><Crash error={new Error('Render failed')} /></ErrorBoundary>);
    // Native summary keyboard activation is verified in Chromium; jsdom does
    // not implement the browser's Enter/Space default action for this element.
    await expand(user);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('reports a denied clipboard write and allows retry', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText')
      .mockRejectedValueOnce(new Error('Denied')).mockResolvedValue();
    render(<ErrorBoundary><Crash error={new Error('Render failed')} /></ErrorBoundary>);
    await expand(user);
    await user.click(screen.getByRole('button', { name: 'Copy Error Details' }));
    expect(screen.getByRole('status')).toHaveTextContent('Could not copy');
    await user.click(screen.getByRole('button', { name: 'Copy Error Details' }));
    expect(screen.getByRole('status')).toHaveTextContent('Error details copied.');
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it('keeps selectable details available when the Clipboard API is unavailable', async () => {
    const user = userEvent.setup();
    render(<ErrorBoundary><Crash error={new Error('Render failed')} /></ErrorBoundary>);
    await expand(user);
    vi.stubGlobal('navigator', { userAgent: navigator.userAgent });
    await user.click(screen.getByRole('button', { name: 'Copy Error Details' }));
    expect(screen.getByRole('status')).toHaveTextContent('Select and copy the details above');
    expect(screen.getByLabelText('Error details')).toHaveTextContent('Render failed');
  });

  it('handles a thrown string without serializing arbitrary objects', async () => {
    const user = userEvent.setup();
    render(<ErrorBoundary><Crash error="A render failure" /></ErrorBoundary>);
    const details = await expand(user);
    expect(details).toHaveTextContent('Error name: Error');
    expect(details).toHaveTextContent('Message: A render failure');
    expect(details).toHaveTextContent('Stack: Not available');
  });

  it('resets technical details and copy feedback when retrying a failed render', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const { rerender } = render(<ErrorBoundary><Crash error={new Error('First failure')} /></ErrorBoundary>);
    await expand(user);
    await user.click(screen.getByRole('button', { name: 'Copy Error Details' }));
    rerender(<ErrorBoundary><Crash error={new Error('Second failure')} /></ErrorBoundary>);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.queryByLabelText('Error details')).not.toBeInTheDocument();
    const details = await expand(user);
    expect(details).toHaveTextContent('Second failure');
    expect(details).not.toHaveTextContent('First failure');
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });
});
