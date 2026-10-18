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

  it('renders dashed SVG lines with gradient definitions in desktop track and mobile connectors', () => {
    render(<HowItWorks />);
    const track = screen.getByTestId('step-track');
    const trackSvg = track.querySelector('svg');
    expect(trackSvg).toBeInTheDocument();
    expect(trackSvg.querySelector('linearGradient#desktop-track-gradient')).toBeInTheDocument();

    const connectors = screen.getAllByTestId('step-connector');
    expect(connectors).toHaveLength(2);
    connectors.forEach((c) => {
      const svg = c.querySelector('svg');
      expect(svg).toBeInTheDocument();
      expect(svg.querySelector('linearGradient#mobile-connector-gradient')).toBeInTheDocument();
    });
  });

  it('respects prefers-reduced-motion media query by defaulting to full progression', () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = (query) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    });

    render(<HowItWorks />);
    const track = screen.getByTestId('step-track');
    const dynamicLine = track.querySelectorAll('line')[1];
    expect(dynamicLine.style.strokeDashoffset).toBe('0');

    window.matchMedia = originalMatchMedia;
  });
});
