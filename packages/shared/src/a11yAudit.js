/**
 * Shared WCAG 2.2 AAA audit harness for the admin and landing accessibility
 * suites (apps/{admin,landing}/src/test/a11y-audit.test.jsx).
 *
 * Both apps measure against this one module on purpose: if each app defined its
 * own ruleset, a page could pass the admin suite and fail the landing one for
 * no real reason, and the combined compliance report would be meaningless.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { configureAxe } from 'jest-axe';
import tailwindColors from 'tailwindcss/colors';

// ── The ruleset ────────────────────────────────────────────────────────────

// axe-core 4.9 tags every rule it can check. `wcag2aaa` is the AAA tag; the
// `wcag22aa` tag brings in the WCAG 2.2 additions (2.4.11 focus-not-obscured,
// 2.5.7 dragging movements, 2.5.8 target size). Nothing in axe covers the rest
// of Level AAA — see MANUAL_ONLY_SUCCESS_CRITERIA below.
export const WCAG_22_AAA_TAGS = [
  'wcag2a',
  'wcag2aa',
  'wcag21a',
  'wcag21aa',
  'wcag22aa',
  'wcag2aaa',
];

export const auditAxe = configureAxe({
  runOnly: { type: 'tag', values: WCAG_22_AAA_TAGS },
  rules: {
    // jsdom has no layout or paint engine, so axe cannot resolve a foreground
    // against a background and both contrast rules are unverifiable here: they
    // would either pass vacuously or fail nondeterministically. Colour is not
    // left unaudited — `contrastRatio` below applies the same §1.4.3 / §1.4.6
    // thresholds directly to the real Tailwind palette values that the audited
    // components actually render.
    'color-contrast': { enabled: false },
    'color-contrast-enhanced': { enabled: false },
  },
});

// Level AAA has 56 success criteria and only 3 of them are machine-checkable
// (1.4.6 contrast-enhanced, 2.4.9 identical-links-same-purpose, 3.2.5
// meta-refresh). The suite therefore reports AAA as "automated ruleset +
// behavioural assertions", and lists the rest here so the report never implies
// coverage the tooling does not have.
export const MANUAL_ONLY_SUCCESS_CRITERIA = [
  { sc: '1.2.6', name: 'Sign Language (Prerecorded)' },
  { sc: '1.2.8', name: 'Media Alternative (Prerecorded)' },
  { sc: '1.2.9', name: 'Audio-only (Live)' },
  { sc: '1.3.5', name: 'Identify Input Purpose' },
  { sc: '1.3.6', name: 'Identify Purpose' },
  { sc: '1.4.5', name: 'Images of Text' },
  { sc: '1.4.7', name: 'Low or No Background Audio' },
  { sc: '1.4.8', name: 'Visual Presentation' },
  { sc: '1.4.9', name: 'Images without Text' },
  { sc: '2.1.3', name: 'Keyboard (No Exception)' },
  { sc: '2.2.3', name: 'No Timing' },
  { sc: '2.2.4', name: 'Interruptions' },
  { sc: '2.2.5', name: 'Re-authenticating' },
  { sc: '2.2.6', name: 'Timeouts' },
  { sc: '2.3.3', name: 'Animation from Interactions' },
  { sc: '2.5.1', name: 'Pointer Gestures' },
  { sc: '2.5.2', name: 'Pointer Cancellation' },
  { sc: '2.5.3', name: 'Label in Name' },
  { sc: '2.5.4', name: 'Motion Actuation' },
  { sc: '2.5.5', name: 'Target Size (Enhanced)' },
  { sc: '2.5.6', name: 'Concurrent Input Mechanisms' },
  { sc: '3.1.3', name: 'Unusual Words' },
  { sc: '3.1.4', name: 'Abbreviations' },
  { sc: '3.1.5', name: 'Reading Level' },
  { sc: '3.1.6', name: 'Pronunciation' },
  { sc: '3.2.3', name: 'Consistent Navigation' },
  { sc: '3.2.4', name: 'Consistent Identification' },
  { sc: '3.2.5', name: 'Change on Request' },
  { sc: '3.2.6', name: 'Consistent Help' },
  { sc: '3.3.5', name: 'Help' },
  { sc: '3.3.6', name: 'Error Prevention (All)' },
  { sc: '3.3.7', name: 'Redundant Entry' },
  { sc: '3.3.8', name: 'Accessible Authentication (Minimum)' },
  { sc: '3.3.9', name: 'Accessible Authentication (Enhanced)' },
];

// ── Colour contrast (WCAG 2.2 §1.4.3 / §1.4.6) ─────────────────────────────

export const CONTRAST_THRESHOLDS = {
  // §1.4.3 Contrast (Minimum) — Level AA.
  AA: 4.5,
  // §1.4.6 Contrast (Enhanced) — Level AAA.
  AAA: 7,
};

const linearise = (channel) => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

export const relativeLuminance = (hex) => {
  const digits = String(hex).replace('#', '').trim();
  const full =
    digits.length === 3
      ? digits
          .split('')
          .map((c) => c + c)
          .join('')
      : digits;
  const [r, g, b] = [0, 2, 4].map((i) => linearise(parseInt(full.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

export const contrastRatio = (a, b) => {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
};

// Colours the apps define in their own tailwind.config.js rather than pulling
// from the Tailwind default palette. Kept in sync with both configs.
const APP_PALETTE = {
  primary: '#0d9488',
  secondary: '#f0fdfa',
  accent: '#14b8a6',
  dark: '#0f172a',
  whatsapp: '#25d366',
  'whatsapp-dark': '#128c7e',
};

// Shade applied when a utility omits one, e.g. `bg-primary` or `text-gray`.
const DEFAULT_SHADE = { text: '500', bg: '100', border: '200' };

/**
 * Resolve a Tailwind colour utility (`text-green-900`, `bg-red-100`,
 * `text-primary`) to its hex value, or null when it is not a colour utility —
 * sizing and weight utilities such as `text-xs` or `bg-black/40` resolve to
 * null and are simply skipped.
 */
export function resolveUtilityColor(utility) {
  const [variant, ...rest] = String(utility).split('-');
  const qualified = rest.join('-');
  if (APP_PALETTE[qualified]) return APP_PALETTE[qualified];

  const [family, shade] = rest;
  const palette = tailwindColors[family];
  if (!palette) return null;
  const wanted = shade || DEFAULT_SHADE[variant] || '500';
  return palette[wanted] || null;
}

/**
 * Pull the background/foreground colour pair out of a Tailwind class list.
 * Returns hexes plus the source utilities, so a failure message can name the
 * exact classes to change.
 */
export function extractColourPair(className) {
  const utilities = String(className || '').split(/\s+/).filter(Boolean);
  const pick = (prefix) => {
    for (const utility of utilities) {
      if (!utility.startsWith(prefix)) continue;
      const hex = resolveUtilityColor(utility);
      if (hex) return { utility, hex };
    }
    return null;
  };
  const background = pick('bg-');
  const foreground = pick('text-');
  return {
    background,
    foreground,
    ratio:
      background && foreground ? contrastRatio(background.hex, foreground.hex) : null,
  };
}

// ── Focus indicator (WCAG 2.2 §2.4.7 / §2.4.11) ────────────────────────────

export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]',
].join(',');

/**
 * Utilities that remove a focus indicator without replacing it. Kept in one
 * place so the suppression check and the replacement check cannot disagree —
 * `ring-0` is a suppressor, not a zero-width ring worth celebrating.
 */
const SUPPRESSED_OUTLINE = new Set(['outline-none', 'outline-hidden', 'ring-0']);

/**
 * Every focusable control must keep a visible focus indicator. jsdom does not
 * apply `:focus-visible` styles, so this reads the utility classes instead:
 * a control that switches the outline off (`outline-none`) has to put a
 * replacement indicator back (`ring-*` or a non-`none` `outline-*` utility),
 * either on itself or on an ancestor. Anything that never touches the outline
 * keeps the user-agent default and passes.
 */
export function findSuppressedFocusIndicators(root) {
  // Tailwind puts state and breakpoint variants in front of the utility
  // (`focus:ring-2`, `focus-visible:outline-2`, `sm:outline-none`), so
  // matching has to compare the utility itself, not the whole class token —
  // otherwise a `focus:ring-2` replacement reads as no replacement at all and
  // every focus ring in the app is reported as a violation.
  const utilityOf = (cls) => cls.replace(/^(?:[a-z-]+:)+/, '');
  const offenders = [];
  for (const el of root.querySelectorAll(FOCUSABLE_SELECTOR)) {
    if (el.tabIndex < 0) continue;
    // The replacement may be set on the control or inherited from a wrapper.
    const chain = [];
    let node = el;
    while (node && node !== root.ownerDocument.body) {
      chain.push(node.getAttribute?.('class') || '');
      node = node.parentElement;
    }
    const utilities = chain.join(' ').split(/\s+/).filter(Boolean).map(utilityOf);
    const suppresses = utilities.some((u) => SUPPRESSED_OUTLINE.has(u));
    if (!suppresses) continue;
    const replaces = utilities.some(
      (u) => !SUPPRESSED_OUTLINE.has(u) && (u.startsWith('ring-') || u.startsWith('outline-'))
    );
    if (replaces) continue;
    offenders.push({
      element: el,
      description: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}`,
      classes: (el.getAttribute('class') || '').trim(),
    });
  }
  return offenders;
}

// ── Report collection ──────────────────────────────────────────────────────

let records = [];

export const resetAuditRecords = () => {
  records = [];
};

export const getAuditRecords = () => records.slice();

/** Add one audited view/state to the report. */
export function recordAudit(entry) {
  records.push(entry);
  return entry;
}

/** Flatten an axe run into the report's violation shape. */
export function summariseViolations(axeResults) {
  return axeResults.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    helpUrl: violation.helpUrl,
    tags: violation.tags.filter((t) => t.startsWith('wcag')),
    nodeCount: violation.nodes.length,
    nodes: violation.nodes.map((node) => ({
      target: node.target,
      html: node.html.slice(0, 400),
      failureSummary: (node.failureSummary || '').trim(),
    })),
  }));
}

export const summariseAxeResults = (axeResults) => ({
  violations: summariseViolations(axeResults),
  passes: axeResults.passes.length,
  incomplete: axeResults.incomplete.length,
  inapplicable: axeResults.inapplicable.length,
});

/** Walks up to the nearest directory whose package.json declares workspaces. */
function findRepoRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    const manifest = path.join(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        if (JSON.parse(readFileSync(manifest, 'utf8')).workspaces) return dir;
      } catch {
        // Unreadable manifest — keep walking upwards.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

export const resolveReportDir = () =>
  process.env.A11Y_REPORT_DIR || path.join(findRepoRoot(process.cwd()), 'reports', 'a11y');

/**
 * Write this app's audit results where scripts/a11y-report.mjs picks them up.
 * Reporting is a convenience, never a reason to fail a test run, so any write
 * error is downgraded to a warning.
 */
export function flushAuditReport(app, meta = {}) {
  try {
    const dir = resolveReportDir();
    mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `${app}.json`);
    const payload = {
      app,
      standard: 'WCAG 2.2 AAA',
      engine: 'axe-core + jest-axe (jsdom)',
      generatedAt: new Date().toISOString(),
      commit: process.env.GITHUB_SHA || process.env.VSCODE_GIT_COMMIT || null,
      workflowRun: process.env.GITHUB_RUN_ID || null,
      ...meta,
      results: getAuditRecords(),
    };
    writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`);
    return target;
  } catch (err) {
    console.warn(`[a11y] could not write audit report: ${err.message}`);
    return null;
  }
}
