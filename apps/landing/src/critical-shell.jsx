import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import Navbar from './components/Navbar.jsx';
import Hero from './components/Hero.jsx';

// Above-the-fold markup used only at build time to decide which CSS rules are
// critical (see build/criticalCss.js). It mirrors the first viewport of "/":
// the sticky navbar and the hero.
export function renderCriticalShell() {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={['/']}>
      <Navbar />
      <main className="flex-grow w-full min-w-0">
        <Hero />
      </main>
    </MemoryRouter>,
  );
}

// The navbar alone is safe to paint on every route before React mounts, so it
// is the only part injected into the shipped index.html.
export function renderNavbarShell() {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={['/']}>
      <Navbar />
    </MemoryRouter>,
  );
}
