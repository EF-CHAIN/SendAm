import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from './App.jsx';
import { whatsappUrl } from '@/lib/links.js';
import { axe } from './test/axe.js';

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>
  );
}

describe('landing page (Home route)', () => {
  it('exposes the primary landmarks: navigation, main, contentinfo', () => {
    renderAt('/');
    expect(screen.getByRole('navigation')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
  });

  it('has exactly one top-level heading (h1) for the page', () => {
    renderAt('/');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('every primary "Start on WhatsApp" CTA uses the configured destination', () => {
    renderAt('/');
    const expectedHref = whatsappUrl('create wallet');
    const ctas = screen.getAllByRole('link', { name: /start on whatsapp/i });
    expect(ctas.length).toBeGreaterThanOrEqual(2); // hero + closing CTA band
    for (const cta of ctas) {
      expect(cta).toHaveAttribute('href', expectedHref);
    }
  });

  it('links the FAQ nav anchor to the rendered FAQ section', () => {
    renderAt('/');
    const main = screen.getByRole('main');
    expect(within(main).getByRole('heading', { name: /frequently asked questions/i })).toBeInTheDocument();
    expect(document.querySelector('#faq')).toBeInTheDocument();
  });

  it('has no automatically detectable high-impact accessibility violations', async () => {
    const { container } = renderAt('/');
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  }, 15000);
});

describe('unknown routes', () => {
  it('renders the not-found page with a way back home', () => {
    renderAt('/this-route-does-not-exist');
    expect(screen.getByText(/404 - page not found/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /return home/i })).toHaveAttribute('href', '/');
  });
});
