import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('Home code splitting', () => {
  it('imports CorridorGlobe and CurrencyCalculator only dynamically', () => {
    const home = readFileSync(path.join(process.cwd(), 'src/pages/Home.jsx'), 'utf8');
    expect(home).not.toMatch(/^import \w+ from '@\/components\/(CurrencyCalculator|CorridorGlobe)/m);
    expect(home).toMatch(/lazy\(loadCurrencyCalculator\)/);
    expect(home).toMatch(/lazy\(loadCorridorGlobe\)/);
    const loaders = readFileSync(path.join(process.cwd(), 'src/lib/lazySections.js'), 'utf8');
    expect(loaders).toMatch(/import\('@\/components\/CurrencyCalculator\.jsx'\)/);
    expect(loaders).toMatch(/import\('@\/components\/CorridorGlobe\.jsx'\)/);
  });

  it('renders placeholders below the fold and the lazy sections once visible', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const { default: Home } = await import('./Home.jsx');
    render(
      <MemoryRouter>
        <Home />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: /see how much your recipient gets/i })).toBeInTheDocument();
    expect(document.getElementById('calculator')).not.toBeNull();
    expect(document.getElementById('geo-corridors')).not.toBeNull();
    vi.unstubAllGlobals();
  });
});
