import { describe, expect, it } from 'vitest';
import { renderCriticalShell, renderNavbarShell } from './critical-shell.jsx';

describe('critical shell markup', () => {
  it('renders the navbar and hero used to select critical CSS', () => {
    const markup = renderCriticalShell();
    expect(markup).toContain('<nav');
    expect(markup).toMatch(/<h1[^>]*>WhatsApp payments with/);
    expect(markup).toContain('class="sticky top-0 z-50');
  });

  it('ships only the route-independent navbar into index.html', () => {
    const markup = renderNavbarShell();
    expect(markup).toContain('<nav');
    expect(markup).not.toContain('<h1');
    expect(markup).not.toContain('<main');
  });
});
