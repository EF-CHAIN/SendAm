import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Skeleton from './Skeleton.jsx';

describe('Skeleton', () => {
  beforeEach(() => {
    const existingStyle = document.getElementById('sendam-skeleton-shimmer-styles');
    if (existingStyle) {
      existingStyle.remove();
    }
  });

  afterEach(() => {
    const existingStyle = document.getElementById('sendam-skeleton-shimmer-styles');
    if (existingStyle) {
      existingStyle.remove();
    }
  });

  it('renders rectangular variant by default with shimmer animation', () => {
    render(<Skeleton />);

    const el = screen.getByRole('status');
    expect(el).toBeDefined();
    expect(el.getAttribute('data-variant')).toBe('rectangular');
    expect(el.getAttribute('data-animation')).toBe('shimmer');
    expect(el.className).toContain('rounded-md');
    expect(el.className).toContain('overflow-hidden');

    // Keyframes style injected
    const styleEl = document.getElementById('sendam-skeleton-shimmer-styles');
    expect(styleEl).not.toBeNull();
    expect(styleEl.textContent).toContain('sendam-skeleton-shimmer');
  });

  it('renders text variant with typography classes', () => {
    render(<Skeleton variant="text" />);

    const el = screen.getByRole('status');
    expect(el.getAttribute('data-variant')).toBe('text');
    expect(el.className).toContain('h-4');
    expect(el.className).toContain('rounded');
  });

  it('renders circular variant with rounded-full', () => {
    render(<Skeleton variant="circular" width={48} />);

    const el = screen.getByRole('status');
    expect(el.getAttribute('data-variant')).toBe('circular');
    expect(el.className).toContain('rounded-full');
    expect(el.style.width).toBe('48px');
    expect(el.style.height).toBe('48px');
  });

  it('supports pulse animation', () => {
    render(<Skeleton animation="pulse" />);

    const el = screen.getByRole('status');
    expect(el.getAttribute('data-animation')).toBe('pulse');
    expect(el.className).toContain('animate-pulse');
  });

  it('supports no animation when animation is "none" or false', () => {
    render(<Skeleton animation="none" />);

    const el = screen.getByRole('status');
    expect(el.getAttribute('data-animation')).toBe('none');
    expect(el.className).not.toContain('animate-pulse');
    expect(el.className).not.toContain('overflow-hidden');
  });

  it('applies custom dimensions (numeric and string)', () => {
    render(<Skeleton width={200} height="5rem" />);

    const el = screen.getByRole('status');
    expect(el.style.width).toBe('200px');
    expect(el.style.height).toBe('5rem');
  });

  it('renders multiple skeleton items when count > 1', () => {
    render(<Skeleton count={4} variant="text" />);

    const group = screen.getByRole('group');
    expect(group).toBeDefined();
    expect(group.getAttribute('aria-busy')).toBe('true');

    const items = screen.getAllByRole('status');
    expect(items.length).toBe(4);
  });

  it('has accessible role and aria attributes', () => {
    render(<Skeleton aria-label="Loading user profile" />);

    const el = screen.getByRole('status');
    expect(el.getAttribute('aria-label')).toBe('Loading user profile');
    expect(el.getAttribute('aria-busy')).toBe('true');
  });
});
