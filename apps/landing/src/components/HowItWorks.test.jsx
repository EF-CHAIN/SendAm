import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import HowItWorks from './HowItWorks.jsx';

describe('HowItWorks', () => {
  it('keeps an ordered list of three steps for assistive technology', () => {
    render(<HowItWorks />);
    const list = screen.getByRole('list');
    expect(list.tagName).toBe('OL');
    // The decorative track is hidden, so only the three real steps are list items.
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('announces each badge as "Step N"', () => {
    render(<HowItWorks />);
    expect(screen.getAllByText('Step')).toHaveLength(3);
    expect(screen.getByRole('heading', { name: /chat or speak/i })).toBeInTheDocument();
  });

  it('draws a desktop progress track that is hidden from assistive tech', () => {
    render(<HowItWorks />);
    const track = screen.getByTestId('step-track');
    expect(track).toHaveAttribute('aria-hidden', 'true');
    expect(track.className).toContain('md:block');
    expect(track.className).toContain('hidden');
  });

  it('adds mobile vertical connectors between steps but not after the last', () => {
    render(<HowItWorks />);
    const connectors = screen.getAllByTestId('step-connector');
    expect(connectors).toHaveLength(2);
    connectors.forEach((c) => {
      expect(c).toHaveAttribute('aria-hidden', 'true');
      expect(c.className).toContain('md:hidden');
    });
  });

  it('only pulses the badges when motion is allowed', () => {
    const { container } = render(<HowItWorks />);
    const pulses = container.querySelectorAll('.motion-safe\\:animate-ping');
    expect(pulses).toHaveLength(3);
  });
});
