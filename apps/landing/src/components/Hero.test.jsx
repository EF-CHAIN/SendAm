import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import Hero from './Hero.jsx';

describe('Hero', () => {
  it('renders the headline and primary calls to action', () => {
    render(<Hero />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/WhatsApp payments/i);
    expect(screen.getByRole('link', { name: /start on whatsapp/i })).toBeInTheDocument();
  });

  it('serves the hero wallpaper as AVIF/WebP with an eager, high-priority fallback img', () => {
    const { container } = render(<Hero />);
    const types = [...container.querySelectorAll('picture > source')].map((s) => s.getAttribute('type'));
    expect(types).toEqual(['image/avif', 'image/webp']);
    const img = container.querySelector('picture > img');
    expect(img).toHaveAttribute('loading', 'eager');
    expect(img).toHaveAttribute('fetchpriority', 'high');
    expect(img).toHaveAttribute('alt', '');
  });

  it('no longer references the PNG wallpaper through a CSS background', () => {
    const { container } = render(<Hero />);
    expect(container.innerHTML).not.toMatch(/bg-\[url/);
  });
});
