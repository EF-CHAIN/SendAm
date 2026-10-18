import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import PhoneFrame from './PhoneFrame.jsx';
import { BEZEL_PRESETS } from './phoneFramePresets.js';

describe('PhoneFrame', () => {
  it('renders children inside the display', () => {
    const { getByText } = render(
      <PhoneFrame>
        <span>chat content</span>
      </PhoneFrame>
    );
    expect(getByText('chat content')).toBeInTheDocument();
  });

  it('defaults to the titanium bezel finish', () => {
    const { container } = render(<PhoneFrame />);
    expect(container.firstChild).toHaveAttribute('data-bezel', 'titanium');
  });

  it.each(['midnight', 'titanium', 'silver'])(
    'records the %s bezel finish on the frame',
    (bezel) => {
      const { container } = render(<PhoneFrame bezel={bezel} />);
      expect(container.firstChild).toHaveAttribute('data-bezel', bezel);
    }
  );

  it('exposes three distinct bezel finishes with full gradients', () => {
    const finishes = Object.keys(BEZEL_PRESETS);
    expect(finishes).toEqual(['midnight', 'titanium', 'silver']);
    finishes.forEach((finish) => {
      const preset = BEZEL_PRESETS[finish];
      expect(preset.frame).toMatch(/^linear-gradient/);
      expect(preset.button).toMatch(/^linear-gradient/);
      expect(preset.buttonAlt).toMatch(/^linear-gradient/);
      expect(preset.edge).toMatch(/^rgba/);
      expect(preset.halo).toMatch(/^rgba/);
      expect(preset.bezel).toMatch(/^#/);
    });
    const frames = finishes.map((finish) => BEZEL_PRESETS[finish].frame);
    expect(new Set(frames).size).toBe(frames.length);
  });

  it('scales frame chrome with container-query units', () => {
    const { container } = render(<PhoneFrame />);
    const wrapper = container.firstChild;
    const frame = wrapper.firstElementChild;
    expect(wrapper.getAttribute('class')).toContain('max-w-[300px]');
    expect(frame.getAttribute('class')).toContain('rounded-[17cqw]');
    expect(frame.getAttribute('class')).toContain('aspect-[75/150]');
  });

  it('renders the Dynamic Island by default', () => {
    const { container } = render(<PhoneFrame />);
    const island = container.querySelector('[data-notch="island"]');
    expect(island).not.toBeNull();
    expect(island.querySelector('span')).not.toBeNull();
    expect(container.querySelector('[data-notch="speaker"]')).toBeNull();
  });

  it('renders the classic speaker notch when dynamicIsland is false', () => {
    const { container } = render(<PhoneFrame dynamicIsland={false} />);
    const notch = container.querySelector('[data-notch="speaker"]');
    expect(notch).not.toBeNull();
    // Speaker grille plus camera lens.
    expect(notch.querySelectorAll('span')).toHaveLength(2);
    expect(container.querySelector('[data-notch="island"]')).toBeNull();
  });

  it('renders the glass reflection overlay by default', () => {
    const { container } = render(<PhoneFrame />);
    const svg = container.querySelector('svg[aria-hidden="true"]');
    expect(svg).not.toBeNull();
    expect(svg.querySelectorAll('linearGradient')).toHaveLength(2);
    expect(svg.querySelectorAll('rect')).toHaveLength(2);
  });

  it('omits the glass reflection overlay when reflection is false', () => {
    const { container } = render(<PhoneFrame reflection={false} />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('gives each instance a unique reflection gradient id', () => {
    const { container } = render(
      <>
        <PhoneFrame />
        <PhoneFrame />
      </>
    );
    const ids = Array.from(container.querySelectorAll('linearGradient')).map(
      (gradient) => gradient.id
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('applies a caller-provided className to the frame', () => {
    const { container } = render(<PhoneFrame className="custom-frame" />);
    const frame = container.firstChild.firstElementChild;
    expect(frame.getAttribute('class')).toContain('custom-frame');
  });
});
