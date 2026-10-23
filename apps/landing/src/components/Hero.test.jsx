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
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import Hero from './Hero.jsx';

describe('Hero Component', () => {
  it('renders the top-level headline and key value propositions', () => {
    render(<Hero />);
    expect(
      screen.getByRole('heading', { level: 1, name: /whatsapp payments with chat and voice/i })
    ).toBeInTheDocument();
    expect(screen.getByText(/no app to install/i)).toBeInTheDocument();
    expect(screen.getByText(/phone number as wallet/i)).toBeInTheDocument();
    expect(screen.getByText(/built on stellar rails/i)).toBeInTheDocument();
  });

  it('renders the mockup within an explicit aspect-ratio containment container to prevent layout shift', () => {
    render(<Hero />);
    const container = screen.getByTestId('hero-mockup-container');
    expect(container).toBeInTheDocument();
    expect(container.className).toContain('aspect-[75/150]');
    expect(container.className).toContain('w-[300px]');
  });

  it('renders a CSS skeleton placeholder behind the phone frame', () => {
    render(<Hero />);
    const skeleton = screen.getByTestId('hero-skeleton-placeholder');
    expect(skeleton).toBeInTheDocument();
    expect(skeleton).toHaveAttribute('aria-hidden', 'true');
    expect(skeleton.className).toContain('motion-safe:animate-pulse');
  });

  it('configures priority hints, eager loading, and explicit dimensions on hero LCP image', () => {
    const { container } = render(<Hero />);
    const logoImg = container.querySelector('img[src="/logo-sent.svg"]');
    expect(logoImg).toBeInTheDocument();
    expect(logoImg).toHaveAttribute('width', '36');
    expect(logoImg).toHaveAttribute('height', '36');
    expect(logoImg).toHaveAttribute('loading', 'eager');
    expect(logoImg.getAttribute('fetchpriority')).toBe('high');
  });
});
