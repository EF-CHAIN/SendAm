import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import Features from './Features.jsx';

describe('Features', () => {
  it('renders all four feature cards as headings', () => {
    render(<Features />);
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(4);
  });

  it('uses a 4-column desktop grid so no card is orphaned', () => {
    const { container } = render(<Features />);
    const grid = container.querySelector('.grid');
    expect(grid.className).toContain('lg:grid-cols-4');
    expect(grid.className).toContain('sm:grid-cols-2');
    expect(grid.className).not.toContain('lg:grid-cols-3');
    expect(grid.children).toHaveLength(4);
  });

  it('gives cards a hover lift and accent border, and animates the icon wrapper', () => {
    const { container } = render(<Features />);
    const card = container.querySelector('.grid > div');
    expect(card.className).toContain('hover:-translate-y-1');
    expect(card.className).toContain('hover:border-primary');
    expect(card.className).toContain('group');
    const iconWrap = card.firstElementChild;
    expect(iconWrap.className).toContain('group-hover:scale-110');
  });

  it('respects reduced motion', () => {
    const { container } = render(<Features />);
    const card = container.querySelector('.grid > div');
    expect(card.className).toContain('motion-reduce:transition-none');
    expect(card.className).toContain('motion-reduce:hover:translate-y-0');
  });

  it('keeps decorative icons hidden from assistive tech', () => {
    const { container } = render(<Features />);
    container.querySelectorAll('svg').forEach((svg) => {
      expect(svg).toHaveAttribute('aria-hidden', 'true');
    });
  });
});
