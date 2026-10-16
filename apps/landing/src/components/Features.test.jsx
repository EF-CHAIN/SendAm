import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

  it('calculates 3D perspective tilt and positions specular highlight on mouse move', () => {
    const { container } = render(<Features />);
    const card = container.querySelector('.grid > div');
    const specular = container.querySelector('[data-testid="specular-highlight"]');

    // Mock getBoundingClientRect
    card.getBoundingClientRect = () => ({
      left: 100,
      top: 100,
      width: 300,
      height: 200,
      right: 400,
      bottom: 300,
    });

    fireEvent.mouseMove(card, { clientX: 200, clientY: 150 });

    expect(card.style.transform).toContain('perspective(1000px)');
    expect(card.style.transform).toContain('rotateX');
    expect(card.style.transform).toContain('rotateY');
    expect(specular.style.opacity).toBe('1');
    expect(specular.style.background).toContain('at 100px 50px');

    // On mouse leave, reset
    fireEvent.mouseLeave(card);
    expect(card.style.transform).toBe('');
    expect(specular.style.opacity).toBe('0');
  });

  it('disables 3D perspective tilt and specular highlight on touch devices', () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = (query) => ({
      matches: query.includes('pointer: coarse') || query.includes('hover: none'),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    });

    try {
      const { container } = render(<Features />);
      const card = container.querySelector('.grid > div');
      const specular = container.querySelector('[data-testid="specular-highlight"]');

      card.getBoundingClientRect = () => ({
        left: 0,
        top: 0,
        width: 300,
        height: 200,
        right: 300,
        bottom: 200,
      });

      fireEvent.mouseMove(card, { clientX: 50, clientY: 50 });
      expect(card.style.transform).toBe('');
      expect(specular.style.opacity).toBe('0');
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it('disables 3D tilt when user prefers reduced motion', () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = (query) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    });

    try {
      const { container } = render(<Features />);
      const card = container.querySelector('.grid > div');
      const specular = container.querySelector('[data-testid="specular-highlight"]');

      card.getBoundingClientRect = () => ({
        left: 0,
        top: 0,
        width: 300,
        height: 200,
        right: 300,
        bottom: 200,
      });

      fireEvent.mouseMove(card, { clientX: 50, clientY: 50 });
      expect(card.style.transform).toBe('');
      expect(specular.style.opacity).toBe('0');
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });
});
