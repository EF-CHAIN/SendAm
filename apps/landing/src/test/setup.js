import '@testing-library/jest-dom/vitest';
import { expect, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { toHaveNoViolations } from 'jest-axe';

expect.extend(toHaveNoViolations);

afterEach(() => {
  cleanup();
});

// jsdom has no layout engine, so window.matchMedia is unimplemented. Several
// components (and the reduced-motion media query in index.css) rely on it
// being present, so stub a "no match" implementation for tests.
if (!window.matchMedia) {
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

// jsdom does not implement HTMLCanvasElement 2D context by default.
if (!HTMLCanvasElement.prototype.getContext || HTMLCanvasElement.prototype.getContext.toString().includes('notImplemented')) {
  HTMLCanvasElement.prototype.getContext = () => ({
    clearRect: () => {},
    beginPath: () => {},
    arc: () => {},
    fill: () => {},
    stroke: () => {},
    moveTo: () => {},
    lineTo: () => {},
    fillText: () => {},
    createRadialGradient: () => ({ addColorStop: () => {} }),
    set strokeStyle(_) {},
    set fillStyle(_) {},
    set lineWidth(_) {},
    set shadowColor(_) {},
    set shadowBlur(_) {},
    set font(_) {},
  });
}

