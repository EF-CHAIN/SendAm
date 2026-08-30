import { configureAxe } from 'jest-axe';

// jsdom has no rendering engine, so it can't resolve computed styles —
// axe's color-contrast check is unreliable there and produces false
// positives/negatives. Every other rule (landmarks, labels, heading order,
// aria attributes, keyboard/focus semantics, etc.) still runs normally.
export const axe = configureAxe({
  rules: {
    'color-contrast': { enabled: false },
  },
});
