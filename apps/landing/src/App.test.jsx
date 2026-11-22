import { describe, expect, it } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { findLowContrastElements } from '@shared/contrast.js';
import App from './App.jsx';
import I18nProvider from '@/lib/I18nProvider.jsx';
import Navbar from './components/Navbar.jsx';
import Hero from './components/Hero.jsx';
import CurrencyCalculator from './components/CurrencyCalculator.jsx';
import Features from './components/Features.jsx';
import OnboardingWizard from './components/OnboardingWizard.jsx';
import HowItWorks from './components/HowItWorks.jsx';
import Faq from './components/Faq.jsx';
import CtaBand from './components/CtaBand.jsx';
import Footer from './components/Footer.jsx';
import { whatsappUrl } from '@/lib/links.js';
import { axe } from './test/axe.js';

const WCAG_21_AA_OPTIONS = {
  runOnly: {
    type: 'tag',
    values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'],
  },
  rules: {
    // Landmark rules apply to full-page documents; isolated component scans
    // wrap children in <main> so region/landmark checks still pass.
    'color-contrast': { enabled: false },
  },
};

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>
  );
}

function renderComponent(ui) {
  return render(
    <MemoryRouter>
      <I18nProvider>
        <main>{ui}</main>
      </I18nProvider>
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

  it('has no automatically detectable WCAG 2.1 Level AA or color-contrast violations', async () => {
    const { container } = renderAt('/');
    const results = await axe(container, WCAG_21_AA_OPTIONS);
    expect(results).toHaveNoViolations();
    expect(findLowContrastElements(container)).toEqual([]);
  }, 15000);
});

describe('WCAG 2.1 Level AA axe-core component audits', () => {
  it('Navbar has zero axe violations and exposes a navigation landmark', async () => {
    const { container } = render(
      <MemoryRouter>
        <I18nProvider>
          <Navbar theme="light" onToggleTheme={() => {}} />
        </I18nProvider>
      </MemoryRouter>
    );
    expect(screen.getByRole('navigation')).toBeInTheDocument();
    const results = await axe(container, WCAG_21_AA_OPTIONS);
    expect(results).toHaveNoViolations();
    expect(findLowContrastElements(container)).toEqual([]);
  }, 15000);

  it('Hero has zero axe violations and a single h1 heading', async () => {
    const { container } = renderComponent(<Hero />);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const results = await axe(container, WCAG_21_AA_OPTIONS);
    expect(results).toHaveNoViolations();
    expect(findLowContrastElements(container)).toEqual([]);
  }, 15000);

  it('CurrencyCalculator has zero axe violations (labels, controls, contrast)', async () => {
    const { container } = renderComponent(<CurrencyCalculator />);
    const results = await axe(container, WCAG_21_AA_OPTIONS);
    expect(results).toHaveNoViolations();
    expect(findLowContrastElements(container)).toEqual([]);
  }, 15000);

  it('Faq has zero axe violations in both collapsed and expanded states', async () => {
    const { container } = renderComponent(<Faq />);
    expect(await axe(container, WCAG_21_AA_OPTIONS)).toHaveNoViolations();

    const firstTrigger = container.querySelector('button[aria-expanded]');
    expect(firstTrigger).not.toBeNull();
    fireEvent.click(firstTrigger);
    expect(firstTrigger).toHaveAttribute('aria-expanded', 'true');

    expect(await axe(container, WCAG_21_AA_OPTIONS)).toHaveNoViolations();
    expect(findLowContrastElements(container)).toEqual([]);
  }, 15000);

  it('OnboardingWizard has zero axe violations across all 3 steps', async () => {
    const { container } = renderComponent(<OnboardingWizard />);
    expect(await axe(container, WCAG_21_AA_OPTIONS)).toHaveNoViolations();

    // Advance to Step 2 (PIN)
    fireEvent.click(screen.getByRole('button', { name: /Next Step/i }));
    expect(await axe(container, WCAG_21_AA_OPTIONS)).toHaveNoViolations();

    // Fill PIN and advance to Step 3 (Transfer simulation)
    screen.getAllByPlaceholderText('•').forEach((input, idx) => {
      fireEvent.change(input, { target: { value: String(idx + 1) } });
    });
    fireEvent.click(screen.getByRole('button', { name: /Next Step/i }));
    expect(await axe(container, WCAG_21_AA_OPTIONS)).toHaveNoViolations();
    expect(findLowContrastElements(container)).toEqual([]);
  }, 15000);

  it('Features, HowItWorks, CtaBand, and Footer have zero axe violations', async () => {
    const { container } = render(
      <MemoryRouter>
        <I18nProvider>
          <main>
            <Features />
            <HowItWorks />
            <CtaBand />
          </main>
          <Footer />
        </I18nProvider>
      </MemoryRouter>
    );
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
    const results = await axe(container, WCAG_21_AA_OPTIONS);
    expect(results).toHaveNoViolations();
    expect(findLowContrastElements(container)).toEqual([]);
  }, 15000);
});

describe('unknown routes', () => {
  it('renders the not-found page with a way back home', () => {
    renderAt('/this-route-does-not-exist');
    expect(screen.getByText(/404 - page not found/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /return home/i })).toHaveAttribute('href', '/');
  });
});
