import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import CtaBand from './CtaBand.jsx';
import { whatsappUrl } from '@/lib/links.js';

describe('CtaBand', () => {
  it('renders the headline as a level-2 heading', () => {
    render(<CtaBand />);
    expect(
      screen.getByRole('heading', { level: 2, name: 'Try your first transfer in 60 seconds' })
    ).toBeInTheDocument();
  });

  it('renders the supporting copy', () => {
    render(<CtaBand />);
    expect(
      screen.getByText(
        /It's free on testnet\. Send one message and watch a Stellar payment\s+settle in seconds\./
      )
    ).toBeInTheDocument();
  });

  it('points the CTA at the WhatsApp "create wallet" deep link from links.js', () => {
    render(<CtaBand />);
    const cta = screen.getByRole('link', { name: 'Start on WhatsApp' });
    expect(cta).toHaveAttribute('href', whatsappUrl('create wallet'));
  });

  it('opens the CTA in a new tab without leaking the opener', () => {
    render(<CtaBand />);
    const cta = screen.getByRole('link', { name: 'Start on WhatsApp' });
    expect(cta).toHaveAttribute('target', '_blank');
    expect(cta).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(cta).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
  });

  it('renders exactly one call to action', () => {
    render(<CtaBand />);
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  describe('localized corridor greeting deep-link', () => {
    it('encodes localized greeting when corridor id is provided', () => {
      render(<CtaBand corridor="uk-ng" />);
      const cta = screen.getByRole('link', { name: 'Start on WhatsApp' });
      expect(cta).toHaveAttribute(
        'href',
        whatsappUrl('Hello SendAm, I want to send money to Nigeria')
      );
      expect(cta.getAttribute('href')).toContain(
        'text=Hello%20SendAm%2C%20I%20want%20to%20send%20money%20to%20Nigeria'
      );
    });

    it('encodes localized greeting for Ghana corridor', () => {
      render(<CtaBand corridor="us-gh" />);
      const cta = screen.getByRole('link', { name: 'Start on WhatsApp' });
      expect(cta).toHaveAttribute(
        'href',
        whatsappUrl('Hello SendAm, I want to send money to Ghana')
      );
    });

    it('encodes localized greeting when corridor object is passed', () => {
      const activeCorridor = {
        to: { country: 'Kenya', name: 'Nairobi, KE' },
      };
      render(<CtaBand corridor={activeCorridor} />);
      const cta = screen.getByRole('link', { name: 'Start on WhatsApp' });
      expect(cta).toHaveAttribute(
        'href',
        whatsappUrl('Hello SendAm, I want to send money to Kenya')
      );
    });

    it('encodes localized greeting when country name string is passed', () => {
      render(<CtaBand corridor="Rwanda" />);
      const cta = screen.getByRole('link', { name: 'Start on WhatsApp' });
      expect(cta).toHaveAttribute(
        'href',
        whatsappUrl('Hello SendAm, I want to send money to Rwanda')
      );
    });

    it('falls back to "create wallet" when corridor is null, empty string, or whitespace', () => {
      const { rerender } = render(<CtaBand corridor={null} />);
      let cta = screen.getByRole('link', { name: 'Start on WhatsApp' });
      expect(cta).toHaveAttribute('href', whatsappUrl('create wallet'));

      rerender(<CtaBand corridor="" />);
      cta = screen.getByRole('link', { name: 'Start on WhatsApp' });
      expect(cta).toHaveAttribute('href', whatsappUrl('create wallet'));

      rerender(<CtaBand corridor="   " />);
      cta = screen.getByRole('link', { name: 'Start on WhatsApp' });
      expect(cta).toHaveAttribute('href', whatsappUrl('create wallet'));
    });
  });
});
