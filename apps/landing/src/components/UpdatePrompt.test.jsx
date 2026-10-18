import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import UpdatePrompt from './UpdatePrompt.jsx';
import { swUpdate } from '@/lib/swUpdate.js';

afterEach(() => swUpdate.reset());

describe('UpdatePrompt', () => {
  it('stays hidden until a new version is waiting', () => {
    render(<UpdatePrompt />);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('prompts once an update is waiting and reloads on request', async () => {
    const updateSW = vi.fn(() => new Promise(() => {}));
    render(<UpdatePrompt />);
    act(() => swUpdate.needRefresh(updateSW));

    const dialog = screen.getByRole('alertdialog', { name: /new version of sendam is ready/i });
    expect(dialog).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(updateSW).toHaveBeenCalledWith(true);
    expect(screen.getByRole('button', { name: /reloading/i })).toBeDisabled();
  });

  it('can be dismissed without reloading', async () => {
    const updateSW = vi.fn();
    render(<UpdatePrompt />);
    act(() => swUpdate.needRefresh(updateSW));
    await userEvent.click(screen.getByRole('button', { name: /dismiss update notice/i }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(updateSW).not.toHaveBeenCalled();
  });
});
