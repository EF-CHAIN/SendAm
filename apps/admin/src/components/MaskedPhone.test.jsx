/**
 * Tests for the shared phone masking utility and the MaskedPhone toggle.
 *
 * The reveal action must not unmask a number until `onReveal` resolves, so the
 * caller can record it in the audit trail. A rejected reveal keeps it masked.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { maskPhoneNumber } from '@shared/maskPhoneNumber.js';
import MaskedPhone from '@shared/MaskedPhone.jsx';
import { revealAdminFields } from '@/lib/adminApi';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

const PHONE = '+2348012344219';
const MASKED = '+234 ••• ••• 4219';

describe('maskPhoneNumber', () => {
  it('keeps the country code and last four digits of an international number', () => {
    expect(maskPhoneNumber(PHONE)).toBe(MASKED);
  });

  it('masks a local number that has no country code', () => {
    expect(maskPhoneNumber('08012344219')).toBe('••• ••• 4219');
  });

  it('returns the full number when revealed', () => {
    expect(maskPhoneNumber(PHONE, true)).toBe(PHONE);
  });

  it('stays masked when the reveal flag is omitted or false', () => {
    expect(maskPhoneNumber(PHONE, false)).toBe(MASKED);
    expect(maskPhoneNumber(PHONE)).not.toContain('8012344');
  });

  it('fully masks numbers too short to show a suffix safely', () => {
    expect(maskPhoneNumber('1234')).toBe('•••');
  });

  it('returns an empty string for missing input', () => {
    expect(maskPhoneNumber(null)).toBe('');
    expect(maskPhoneNumber(undefined)).toBe('');
    expect(maskPhoneNumber('')).toBe('');
  });
});

describe('MaskedPhone', () => {
  it('renders the masked number and no unmasked digits by default', () => {
    render(<MaskedPhone phone={PHONE} onReveal={vi.fn()} />);

    expect(screen.getByText(MASKED)).toBeInTheDocument();
    expect(screen.queryByText(PHONE)).not.toBeInTheDocument();
  });

  it('calls onReveal once and unmasks the number after it resolves', async () => {
    const user = userEvent.setup();
    const onReveal = vi.fn().mockResolvedValue(undefined);
    render(<MaskedPhone phone={PHONE} onReveal={onReveal} />);

    await user.click(screen.getByRole('button', { name: 'Reveal phone number' }));

    expect(onReveal).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(PHONE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide phone number' })).toBeInTheDocument();
  });

  it('re-masks on hide without calling onReveal, and audits each new reveal', async () => {
    const user = userEvent.setup();
    const onReveal = vi.fn().mockResolvedValue(undefined);
    render(<MaskedPhone phone={PHONE} onReveal={onReveal} />);

    await user.click(screen.getByRole('button', { name: 'Reveal phone number' }));
    await screen.findByText(PHONE);

    await user.click(screen.getByRole('button', { name: 'Hide phone number' }));
    expect(screen.getByText(MASKED)).toBeInTheDocument();
    expect(onReveal).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Reveal phone number' }));
    await screen.findByText(PHONE);
    expect(onReveal).toHaveBeenCalledTimes(2);
  });

  it('stays masked and shows an error when onReveal rejects', async () => {
    const user = userEvent.setup();
    const onReveal = vi.fn().mockRejectedValue(new Error('forbidden'));
    render(<MaskedPhone phone={PHONE} onReveal={onReveal} />);

    await user.click(screen.getByRole('button', { name: 'Reveal phone number' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not reveal number/i);
    expect(screen.getByText(MASKED)).toBeInTheDocument();
    expect(screen.queryByText(PHONE)).not.toBeInTheDocument();
  });

  it('sends the reveal request for the record that was clicked', async () => {
    const user = userEvent.setup();
    const requested = vi.fn();
    server.use(
      http.post('*/api/admin/reveal/:resource/:id', ({ params }) => {
        requested(`${params.resource}/${params.id}`);
        return HttpResponse.json({ success: true, data: { fields: { phoneNumber: PHONE } } });
      })
    );
    render(
      <MaskedPhone phone={PHONE} onReveal={() => revealAdminFields('user', 'u-42')} />
    );

    await user.click(screen.getByRole('button', { name: 'Reveal phone number' }));

    expect(await screen.findByText(PHONE)).toBeInTheDocument();
    expect(requested).toHaveBeenCalledWith('user/u-42');
  });

  it('renders a dash when there is no phone number', () => {
    render(<MaskedPhone phone={null} onReveal={vi.fn()} />);

    expect(screen.getByText('-')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
