import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import LiveFeedIndicator from './LiveFeedIndicator';

describe('LiveFeedIndicator Component', () => {
  it('renders connected state correctly', () => {
    render(<LiveFeedIndicator state="connected" />);
    expect(screen.getByText(/Live Feed/i)).toBeInTheDocument();
  });

  it('renders reconnecting state correctly', () => {
    render(<LiveFeedIndicator state="reconnecting" />);
    expect(screen.getByText(/Reconnecting\.\.\./i)).toBeInTheDocument();
  });

  it('renders disconnected state and retry button', () => {
    const onReconnect = vi.fn();
    render(<LiveFeedIndicator state="disconnected" onReconnect={onReconnect} />);
    expect(screen.getByText(/Disconnected/i)).toBeInTheDocument();

    const retryBtn = screen.getByRole('button', { name: /Retry/i });
    expect(retryBtn).toBeInTheDocument();
    fireEvent.click(retryBtn);
    expect(onReconnect).toHaveBeenCalled();
  });
});
