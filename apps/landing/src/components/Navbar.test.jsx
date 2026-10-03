import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Navbar from './Navbar.jsx';
import { whatsappUrl } from '@/lib/links.js';

function renderNavbar() {
  return render(
    <MemoryRouter>
      <Navbar />
    </MemoryRouter>
  );
}

describe('Navbar', () => {
  it('exposes a navigation landmark', () => {
    renderNavbar();
    expect(screen.getByRole('navigation')).toBeInTheDocument();
  });

  it('links the brand mark back to the home route', () => {
    renderNavbar();
    expect(screen.getByRole('link', { name: /sendam/i })).toHaveAttribute('href', '/');
  });

  it('links in-page sections to their matching anchors', () => {
    renderNavbar();
    expect(screen.getByRole('link', { name: 'Features' })).toHaveAttribute('href', '#features');
    expect(screen.getByRole('link', { name: 'How it works' })).toHaveAttribute(
      'href',
      '#how-it-works'
    );
    expect(screen.getByRole('link', { name: 'FAQ' })).toHaveAttribute('href', '#faq');
  });

  it('points the primary CTA at the configured WhatsApp destination', () => {
    renderNavbar();
    const cta = screen.getByRole('link', { name: /whatsapp|start/i });
    expect(cta).toHaveAttribute('href', whatsappUrl('create wallet'));
    expect(cta).toHaveAttribute('target', '_blank');
    // External-tab links must carry noopener/noreferrer so the new tab can't
    // reach back into this page via window.opener.
    expect(cta).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(cta).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
  });

  it('is fully reachable by keyboard, in document order', async () => {
    const user = userEvent.setup();
    renderNavbar();

    const links = screen.getAllByRole('link');
    for (const link of links) {
      await user.tab();
      expect(link).toHaveFocus();
    }
  });

  it('gives the primary CTA an explicit visible focus style', () => {
    // The brand mark and plain in-page anchors rely on the browser's default
    // focus ring (confirmed non-violating by the axe scan in App.test.jsx).
    // The CTA button overrides its own background/text color, so it needs an
    // explicit focus-visible outline to stay visible against that styling.
    renderNavbar();
    const cta = screen.getByRole('link', { name: /whatsapp|start/i });
    expect(cta.className).toMatch(/focus-visible:outline/);
  });

  describe('mobile drawer', () => {
    afterEach(() => {
      document.body.style.overflow = '';
      document.getElementById('faq')?.remove();
      vi.restoreAllMocks();
    });

    const toggle = () => screen.getByRole('button', { name: /open menu/i });

    it('renders a hamburger button that is collapsed by default', () => {
      renderNavbar();
      expect(toggle()).toHaveAttribute('aria-expanded', 'false');
      expect(toggle()).toHaveAttribute('aria-controls', 'mobile-nav-drawer');
      expect(toggle().className).toMatch(/md:hidden/);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('opens the drawer with every nav link and the WhatsApp CTA', async () => {
      const user = userEvent.setup();
      renderNavbar();
      await user.click(toggle());

      const dialog = screen.getByRole('dialog', { name: /site navigation/i });
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(screen.getByRole('button', { name: /close menu/i, expanded: true })).toBeInTheDocument();
      for (const name of ['Features', 'How it works', 'FAQ', 'Onboarding']) {
        expect(within(dialog).getByRole('link', { name })).toBeInTheDocument();
      }
      expect(within(dialog).getByRole('link', { name: /open whatsapp/i })).toHaveAttribute(
        'href',
        whatsappUrl('create wallet')
      );
      expect(document.body.style.overflow).toBe('hidden');
    });

    it('closes on Escape, restores scroll and returns focus to the toggle', async () => {
      const user = userEvent.setup();
      renderNavbar();
      await user.click(toggle());
      await user.keyboard('{Escape}');

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(document.body.style.overflow).toBe('');
      expect(toggle()).toHaveFocus();
    });

    it('closes when the backdrop is clicked', async () => {
      const user = userEvent.setup();
      renderNavbar();
      await user.click(toggle());
      await user.click(screen.getByTestId('nav-backdrop'));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('moves focus into the drawer and traps Tab and Shift+Tab inside it', async () => {
      const user = userEvent.setup();
      renderNavbar();
      await user.click(toggle());

      const dialog = screen.getByRole('dialog');
      const focusable = within(dialog).getAllByRole('link');
      const closeButton = within(dialog).getByRole('button', { name: /close menu/i });
      expect(closeButton).toHaveFocus();

      // Tab through everything, then once more: focus wraps to the first item.
      for (let i = 0; i < focusable.length; i += 1) await user.tab();
      expect(focusable[focusable.length - 1]).toHaveFocus();
      await user.tab();
      expect(closeButton).toHaveFocus();

      await user.tab({ shift: true });
      expect(focusable[focusable.length - 1]).toHaveFocus();
      expect(dialog.contains(document.activeElement)).toBe(true);
    });

    it('closes and smooth-scrolls to the section when a section link is clicked', async () => {
      const user = userEvent.setup();
      const section = document.createElement('section');
      section.id = 'faq';
      section.scrollIntoView = vi.fn();
      document.body.appendChild(section);

      renderNavbar();
      await user.click(toggle());
      await user.click(within(screen.getByRole('dialog')).getByRole('link', { name: 'FAQ' }));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(document.body.style.overflow).toBe('');
      expect(section.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    });

    it('closes when the Onboarding link is followed', async () => {
      const user = userEvent.setup();
      renderNavbar();
      await user.click(toggle());
      await user.click(within(screen.getByRole('dialog')).getByRole('link', { name: 'Onboarding' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });
});
