import { configureAxe } from 'jest-axe';

// jsdom has no rendering engine, so it can't resolve computed styles —
// axe's color-contrast check is unreliable there and produces false
// positives/negatives. Every other rule (landmarks, labels, heading order,
// aria attributes, keyboard/focus semantics, table semantics, etc.) still
// runs normally. Mirrors apps/landing/src/test/axe.js.
export const axe = configureAxe({
  rules: {
    'color-contrast': { enabled: false },
  },
});

// WCAG 2.1 level A and AA rules only. Used by the component-level audits in
// accessibility.test.jsx so a failure maps directly to a WCAG 2.1 AA criterion.
export const WCAG_21_AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

export const axeWcag21AA = configureAxe({
  runOnly: { type: 'tag', values: WCAG_21_AA_TAGS },
  rules: {
    'color-contrast': { enabled: false },
  },
});
