#!/usr/bin/env node
/**
 * Renders the accessibility audit results collected by
 * apps/{admin,landing}/src/test/a11y-audit.test.jsx into a single standalone
 * HTML compliance report.
 *
 *   node scripts/a11y-report.mjs [--dir <report-dir>] [--out <file>]
 *                                 [--title <title>] [--strict]
 *
 * The test suites write one JSON file per app (reports/a11y/<app>.json by
 * default, override with A11Y_REPORT_DIR or --dir). This script only reads and
 * renders them — it never runs a browser — so it works anywhere Node does and
 * needs no network access. The output is a single self-contained file with no
 * external assets, so it can be uploaded as a CI artifact and opened straight
 * from disk.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_REPORT_DIR = path.join(REPO_ROOT, 'reports', 'a11y');
const DEFAULT_OUT = path.join(REPO_ROOT, 'reports', 'a11y', 'accessibility-report.html');

// Every app that is expected to contribute results. A missing file means that
// app's suite did not run (or crashed before flushing), which is itself worth
// reporting rather than silently treating as "no problems".
const EXPECTED_APPS = ['admin', 'landing'];

function parseArgs(argv) {
  const args = { dir: DEFAULT_REPORT_DIR, out: DEFAULT_OUT, title: 'SendAm Accessibility Compliance Report', strict: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dir') args.dir = path.resolve(argv[++i] || '');
    else if (arg === '--out') args.out = path.resolve(argv[++i] || '');
    else if (arg === '--title') args.title = argv[++i] || args.title;
    else if (arg === '--strict') args.strict = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

const USAGE = `
Usage: node scripts/a11y-report.mjs [options]

  --dir <path>    Directory holding <app>.json audit results.
                  Default: ${DEFAULT_REPORT_DIR}
  --out <file>    HTML report destination.
                  Default: ${DEFAULT_OUT}
  --title <text>  Report title.
  --strict        Exit non-zero if any view has violations or an app is missing.
  -h, --help      Show this help.
`;

// ── Loading ────────────────────────────────────────────────────────────────

function loadResults(dir) {
  if (!existsSync(dir)) return { files: [], apps: [], missing: EXPECTED_APPS };
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const apps = [];
  for (const file of files) {
    try {
      apps.push(JSON.parse(readFileSync(path.join(dir, file), 'utf8')));
    } catch (err) {
      apps.push({ app: path.basename(file, '.json'), loadError: err.message, results: [] });
    }
  }
  const seen = new Set(apps.map((a) => a.app));
  return { files, apps, missing: EXPECTED_APPS.filter((app) => !seen.has(app)) };
}

function tally(apps) {
  const totals = { views: 0, violations: 0, passes: 0, incomplete: 0, focusIndicators: 0, failedViews: 0 };
  for (const app of apps) {
    for (const result of app.results || []) {
      totals.views += 1;
      totals.violations += result.violations.length;
      totals.passes += result.passes || 0;
      totals.incomplete += result.incomplete || 0;
      totals.focusIndicators += (result.suppressedFocusIndicators || []).length;
      if (result.status !== 'pass') totals.failedViews += 1;
    }
  }
  return totals;
}

// ── Rendering ──────────────────────────────────────────────────────────────

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const IMPACT_ORDER = ['critical', 'serious', 'moderate', 'minor'];

const renderViolation = (violation) => {
  const nodes = violation.nodes
    .map(
      (node) => `
        <li class="node">
          <p class="node-target"><code>${escapeHtml(node.target.join(' '))}</code></p>
          <pre class="node-html"><code>${escapeHtml(node.html)}</code></pre>
          ${node.failureSummary ? `<p class="node-summary">${escapeHtml(node.failureSummary)}</p>` : ''}
        </li>`
    )
    .join('');
  return `
      <article class="violation">
        <h4>
          <span class="impact impact-${escapeHtml(violation.impact || 'unknown')}">${escapeHtml(violation.impact || 'unknown')}</span>
          <code>${escapeHtml(violation.id)}</code>
        </h4>
        <p>${escapeHtml(violation.help)}</p>
        <p class="tags">${(violation.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</p>
        <ol class="nodes">${nodes}</ol>
        ${violation.helpUrl ? `<p><a href="${escapeHtml(violation.helpUrl)}">Rule reference</a></p>` : ''}
      </article>`;
};

const renderView = (result) => {
  const ok = result.status === 'pass';
  const details = [
    ...result.violations,
    ...(result.suppressedFocusIndicators || []).map((o) => ({
      id: 'suppressed-focus-indicator',
      impact: 'serious',
      help: o.help,
      helpUrl: null,
      tags: ['manual-check'],
      nodes: [{ target: [o.element], html: `class="${o.classes}"`, failureSummary: o.help }],
    })),
  ].sort((a, b) => IMPACT_ORDER.indexOf(a.impact) - IMPACT_ORDER.indexOf(b.impact));

  return `
    <details class="view"${ok ? '' : ' open'}>
      <summary>
        <span class="badge ${ok ? 'pass' : 'fail'}">${ok ? 'Pass' : 'Fail'}</span>
        <code>${escapeHtml(result.route)}</code>
        <span class="state">${escapeHtml(result.state)}</span>
        <span class="counts">${result.violations.length} violation(s) &middot; ${result.passes} rule(s) passed &middot; ${result.incomplete} needs review${result.durationMs ? ` &middot; ${result.durationMs}ms` : ''}</span>
      </summary>
      ${details.length === 0 ? '<p class="ok">No detectable violations in this view.</p>' : details.map(renderViolation).join('')}
    </details>`;
};

const renderApp = (app) => {
  const results = app.results || [];
  const failed = results.filter((r) => r.status !== 'pass').length;
  return `
    <section class="app" aria-labelledby="app-${escapeHtml(app.app)}">
      <h3 id="app-${escapeHtml(app.app)}">${escapeHtml(app.app)}</h3>
      ${app.loadError ? `<p class="fail-note">Could not read results: ${escapeHtml(app.loadError)}</p>` : ''}
      <p class="app-meta">
        ${results.length} view(s) audited &middot; ${failed} failing &middot; ruleset: ${escapeHtml(results[0]?.ruleset || 'WCAG 2.2 (A + AA + AAA) via axe-core')}
        ${app.generatedAt ? ` &middot; collected ${escapeHtml(app.generatedAt)}` : ''}
      </p>
      <div class="views">${results.map(renderView).join('') || '<p class="fail-note">No views were recorded.</p>'}</div>
    </section>`;
};

const renderManualSection = (apps) => {
  const criteria = apps.find((a) => a.manualOnlySuccessCriteria)?.manualOnlySuccessCriteria || [];
  if (criteria.length === 0) return '';
  const items = criteria
    .map(
      (c) =>
        `<li><code>${escapeHtml(c.sc)}</code> ${escapeHtml(c.name)} <span class="tag">manual</span></li>`
    )
    .join('');
  return `
    <section class="advisory" aria-labelledby="manual-heading">
      <h3 id="manual-heading">Level AAA criteria that need human review</h3>
      <p>
        axe-core can only machine-check three of the 56 Level AAA success criteria
        (1.4.6 Contrast (Enhanced), 2.4.9 Link Purpose (In Context), 3.2.5 Change on Request).
        The remaining criteria below cannot be verified by any automated scanner and
        remain the responsibility of manual audit — this report does not claim them.
      </p>
      <ul class="manual-list">${items}</ul>
    </section>`;
};

function renderHtml({ apps, missing, totals, title, out }) {
  const clean = totals.violations === 0 && totals.focusIndicators === 0 && missing.length === 0 && totals.views > 0;
  const commit = apps.find((a) => a.commit)?.commit;
  const runId = apps.find((a) => a.workflowRun)?.workflowRun;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root {
    --ink: #0f172a; --muted: #475569; --line: #cbd5e1; --bg: #f8fafc; --panel: #ffffff;
    --pass: #14532d; --pass-bg: #dcfce7; --fail: #7f1d1d; --fail-bg: #fee2e2;
    --focus: #0d9488;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2rem 1.5rem 4rem; background: var(--bg); color: var(--ink);
    font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  main { max-width: 68rem; margin: 0 auto; }
  h1 { font-size: 1.875rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.25rem; margin: 2.5rem 0 .75rem; padding-bottom: .375rem; border-bottom: 2px solid var(--line); }
  h3 { font-size: 1.0625rem; margin: 1.75rem 0 .5rem; }
  h4 { font-size: 1rem; margin: 0 0 .375rem; display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .875em; }
  a { color: #0f766e; }
  a:focus-visible, summary:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
  .meta { color: var(--muted); margin: 0 0 1.5rem; }
  .verdict { border-radius: .5rem; padding: 1rem 1.25rem; margin: 1.5rem 0; border: 2px solid; }
  .verdict.pass { background: var(--pass-bg); border-color: var(--pass); color: var(--pass); }
  .verdict.fail { background: var(--fail-bg); border-color: var(--fail); color: var(--fail); }
  .verdict h2 { border: 0; margin: 0 0 .25rem; padding: 0; font-size: 1.125rem; color: inherit; }
  .verdict p { margin: 0; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr)); gap: .75rem; margin: 1.5rem 0; padding: 0; list-style: none; }
  .cards li { background: var(--panel); border: 1px solid var(--line); border-radius: .5rem; padding: .875rem; }
  .cards .num { display: block; font-size: 1.5rem; font-weight: 700; }
  .cards .lbl { display: block; color: var(--muted); font-size: .8125rem; }
  .view { background: var(--panel); border: 1px solid var(--line); border-radius: .5rem; margin: .5rem 0; }
  .view > summary { cursor: pointer; padding: .75rem .875rem; display: flex; align-items: center; gap: .625rem; flex-wrap: wrap; list-style-position: inside; }
  .view > summary .state { color: var(--muted); font-size: .8125rem; }
  .view > summary .counts { margin-left: auto; color: var(--muted); font-size: .8125rem; }
  .badge { font-size: .75rem; font-weight: 700; padding: .0625rem .5rem; border-radius: 999px; border: 1px solid; }
  .badge.pass { background: var(--pass-bg); color: var(--pass); border-color: var(--pass); }
  .badge.fail { background: var(--fail-bg); color: var(--fail); border-color: var(--fail); }
  .violation { border-top: 1px solid var(--line); padding: .875rem; }
  .impact { font-size: .6875rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; padding: .0625rem .4375rem; border-radius: .25rem; border: 1px solid; }
  .impact-critical, .impact-serious { background: var(--fail-bg); color: var(--fail); border-color: var(--fail); }
  .impact-moderate, .impact-minor { background: #fef9c3; color: #713f12; border-color: #713f12; }
  .impact-unknown { background: var(--bg); color: var(--muted); border-color: var(--line); }
  .tags { margin: .25rem 0; }
  .tag { display: inline-block; font-size: .6875rem; background: var(--bg); border: 1px solid var(--line); border-radius: .25rem; padding: 0 .375rem; margin-right: .25rem; color: var(--muted); }
  .nodes { margin: .5rem 0 0; padding-left: 1.25rem; }
  .node { margin-bottom: .625rem; }
  .node-target { margin: 0 0 .25rem; }
  .node-html { margin: 0; padding: .5rem; background: var(--bg); border: 1px solid var(--line); border-radius: .25rem; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
  .node-summary { margin: .25rem 0 0; color: var(--muted); font-size: .875rem; }
  .ok, .app-meta, .fail-note { color: var(--muted); font-size: .875rem; }
  .ok, .app-meta { padding: 0 .875rem .75rem; margin: 0; }
  .fail-note { color: var(--fail); font-weight: 600; }
  .advisory { background: var(--panel); border: 1px solid var(--line); border-radius: .5rem; padding: 1rem 1.25rem; }
  .advisory p { margin-top: 0; }
  .manual-list { columns: 2 15rem; margin: 0; padding-left: 1.25rem; font-size: .875rem; }
  footer { margin-top: 3rem; color: var(--muted); font-size: .8125rem; border-top: 1px solid var(--line); padding-top: 1rem; }
  @media print { body { background: #fff; } .view > summary { list-style: none; } }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(title)}</h1>
  <p class="meta">
    Generated ${escapeHtml(new Date().toISOString())} &middot; standard: WCAG 2.2 Level AAA
    ${commit ? ` &middot; commit <code>${escapeHtml(String(commit).slice(0, 12))}</code>` : ''}
    ${runId ? ` &middot; workflow run ${escapeHtml(runId)}` : ''}
  </p>

  <div class="verdict ${clean ? 'pass' : 'fail'}">
    <h2>${clean ? 'No automated WCAG 2.2 violations detected' : 'Accessibility violations detected'}</h2>
    <p>${
      clean
        ? `All ${totals.views} audited view(s) across ${apps.length} app(s) passed every rule in the automated ruleset and every behavioural assertion.`
        : `${totals.violations} rule violation(s) and ${totals.focusIndicators} focus-indicator issue(s) across ${totals.failedViews} failing view(s).`
    }${missing.length ? ` Apps without results: ${missing.map(escapeHtml).join(', ')}.` : ''}</p>
  </div>

  <ul class="cards">
    <li><span class="num">${totals.views}</span><span class="lbl">views audited</span></li>
    <li><span class="num">${apps.length}</span><span class="lbl">apps covered</span></li>
    <li><span class="num">${totals.passes}</span><span class="lbl">rule checks passed</span></li>
    <li><span class="num">${totals.violations}</span><span class="lbl">violations</span></li>
    <li><span class="num">${totals.incomplete}</span><span class="lbl">needs manual review</span></li>
    <li><span class="num">${totals.focusIndicators}</span><span class="lbl">focus issues</span></li>
  </ul>

  <h2>Audited views</h2>
  ${apps.map(renderApp).join('')}

  ${renderManualSection(apps)}

  <h2>Method</h2>
  <ul>
    <li>Every route in each app is rendered against mocked API data and scanned with axe-core, restricted to the WCAG 2.2 A, AA and AAA rule tags.</li>
    <li>Each route is scanned in every meaningful DOM state (loading, loaded, empty, error, and open dialogs where applicable).</li>
    <li>axe runs in jsdom, which has no layout or paint engine, so its two colour rules cannot resolve a foreground against a background. Colour is instead checked directly against the Tailwind palette values the components render, at the 7:1 Level AAA threshold of WCAG 1.4.6.</li>
    <li>Behaviour that a static scan cannot observe — dialog focus containment and restoration, aria-sort transitions, live-region announcements — is asserted directly in the test suite.</li>
    <li>A pass means no <em>detectable</em> violation. It is not a claim of full AAA conformance; see the manual-review list above.</li>
  </ul>

  <footer>
    Report: <code>${escapeHtml(path.relative(REPO_ROOT, out) || out)}</code>
    &middot; source data: <code>${escapeHtml(apps.map((a) => a.app).join(', ') || 'none')}</code>
    &middot; generated by <code>scripts/a11y-report.mjs</code>
  </footer>
</main>
</body>
</html>
`;
}

// ── Entry point ────────────────────────────────────────────────────────────

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }

  const { apps, missing } = loadResults(args.dir);
  const totals = tally(apps);

  if (apps.length === 0) {
    console.error(
      `No audit results found in ${args.dir}.\n` +
        'Run the accessibility suites first:\n' +
        '  npm run test:admin && npm run test:landing'
    );
    process.exit(1);
  }

  const html = renderHtml({ apps, missing, totals, title: args.title, out: args.out });
  mkdirSync(path.dirname(args.out), { recursive: true });
  writeFileSync(args.out, html);

  const clean = totals.violations === 0 && totals.focusIndicators === 0 && missing.length === 0;
  console.log(
    `Accessibility report written to ${path.relative(REPO_ROOT, args.out)}\n` +
      `  apps: ${apps.map((a) => a.app).join(', ')}` +
      `${missing.length ? ` (missing: ${missing.join(', ')})` : ''}\n` +
      `  views audited: ${totals.views}\n` +
      `  rule checks passed: ${totals.passes}\n` +
      `  violations: ${totals.violations}\n` +
      `  focus-indicator issues: ${totals.focusIndicators}\n` +
      `  needs manual review: ${totals.incomplete}`
  );

  if (args.strict && !clean) {
    console.error('\n--strict: accessibility audit did not pass.');
    process.exit(1);
  }
}

main();
