#!/usr/bin/env node
/**
 * check-frontend-budgets.js
 *
 * Reads the built dist/ outputs for each app and asserts them against the
 * budgets in scripts/bundle-budgets.config.json.
 *
 * Exit 0 = all budgets pass.
 * Exit 1 = one or more budgets breached — CI should treat this as a failure.
 *
 * Usage:  node scripts/check-frontend-budgets.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CONFIG_PATH = path.join(__dirname, 'bundle-budgets.config.json');
const ROOT = path.join(__dirname, '..');

// ── helpers ──────────────────────────────────────────────────────────────────

function gzipSize(filePath) {
  const raw = fs.readFileSync(filePath);
  return zlib.gzipSync(raw).length;
}

function sizeKb(bytes) {
  return +(bytes / 1024).toFixed(2);
}

function walk(dir, ext) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full, ext);
    if (entry.isFile() && entry.name.endsWith(ext)) return [full];
    return [];
  });
}

// ── main ─────────────────────────────────────────────────────────────────────

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

let failures = 0;
const report = [];

for (const [appName, appConfig] of Object.entries(config.apps)) {
  const distPath = path.join(ROOT, appConfig.distDir);
  const budgets = appConfig.budgets;

  report.push(`\n══ ${appName.toUpperCase()} (${appConfig.distDir}) ══`);

  if (!fs.existsSync(distPath)) {
    report.push(`  ✗ dist directory not found: ${distPath}`);
    report.push(`    Run 'npm run build:${appName}' first.`);
    failures++;
    continue;
  }

  const jsFiles = walk(path.join(distPath, 'assets'), '.js');
  const cssFiles = walk(path.join(distPath, 'assets'), '.css');
  const imageFiles = [
    ...walk(distPath, '.png'),
    ...walk(distPath, '.jpg'),
    ...walk(distPath, '.jpeg'),
    ...walk(distPath, '.webp'),
    ...walk(distPath, '.gif'),
  ];

  // ── Total JS (raw) ──
  const totalJsBytes = jsFiles.reduce((s, f) => s + fs.statSync(f).size, 0);
  const totalJsKb = sizeKb(totalJsBytes);
  const jsPass = totalJsKb <= budgets.totalJsKb;
  if (!jsPass) failures++;
  report.push(
    `  ${jsPass ? '✓' : '✗'} Total JS  : ${totalJsKb} KB` +
    ` (budget: ${budgets.totalJsKb} KB)` +
    (jsPass ? '' : ` ← OVER by ${(totalJsKb - budgets.totalJsKb).toFixed(2)} KB`)
  );

  // ── Total JS (gzip) ──
  if (budgets.gzip?.totalJsKb) {
    const totalJsGzipKb = sizeKb(jsFiles.reduce((s, f) => s + gzipSize(f), 0));
    const jsGzipPass = totalJsGzipKb <= budgets.gzip.totalJsKb;
    if (!jsGzipPass) failures++;
    report.push(
      `  ${jsGzipPass ? '✓' : '✗'} Total JS (gzip): ${totalJsGzipKb} KB` +
      ` (budget: ${budgets.gzip.totalJsKb} KB)` +
      (jsGzipPass ? '' : ` ← OVER by ${(totalJsGzipKb - budgets.gzip.totalJsKb).toFixed(2)} KB`)
    );
  }

  // ── Max single JS chunk ──
  for (const f of jsFiles) {
    const chunkKb = sizeKb(fs.statSync(f).size);
    const chunkPass = chunkKb <= budgets.maxChunkKb;
    if (!chunkPass) failures++;
    const rel = path.relative(ROOT, f);
    report.push(
      `  ${chunkPass ? '✓' : '✗'} Chunk     : ${rel} — ${chunkKb} KB` +
      ` (max: ${budgets.maxChunkKb} KB)` +
      (chunkPass ? '' : ` ← OVER by ${(chunkKb - budgets.maxChunkKb).toFixed(2)} KB`)
    );
  }

  // ── Total CSS (raw) ──
  const totalCssBytes = cssFiles.reduce((s, f) => s + fs.statSync(f).size, 0);
  const totalCssKb = sizeKb(totalCssBytes);
  const cssPass = totalCssKb <= budgets.totalCssKb;
  if (!cssPass) failures++;
  report.push(
    `  ${cssPass ? '✓' : '✗'} Total CSS : ${totalCssKb} KB` +
    ` (budget: ${budgets.totalCssKb} KB)` +
    (cssPass ? '' : ` ← OVER by ${(totalCssKb - budgets.totalCssKb).toFixed(2)} KB`)
  );

  // ── Total CSS (gzip) ──
  if (budgets.gzip?.totalCssKb) {
    const totalCssGzipKb = sizeKb(cssFiles.reduce((s, f) => s + gzipSize(f), 0));
    const cssGzipPass = totalCssGzipKb <= budgets.gzip.totalCssKb;
    if (!cssGzipPass) failures++;
    report.push(
      `  ${cssGzipPass ? '✓' : '✗'} Total CSS (gzip): ${totalCssGzipKb} KB` +
      ` (budget: ${budgets.gzip.totalCssKb} KB)` +
      (cssGzipPass ? '' : ` ← OVER by ${(totalCssGzipKb - budgets.gzip.totalCssKb).toFixed(2)} KB`)
    );
  }

  // ── Images ──
  for (const f of imageFiles) {
    const imgKb = sizeKb(fs.statSync(f).size);
    const imgPass = imgKb <= budgets.maxImageKb;
    if (!imgPass) failures++;
    const rel = path.relative(ROOT, f);
    report.push(
      `  ${imgPass ? '✓' : '✗'} Image     : ${rel} — ${imgKb} KB` +
      ` (max: ${budgets.maxImageKb} KB)` +
      (imgPass ? '' : ` ← OVER by ${(imgKb - budgets.maxImageKb).toFixed(2)} KB`)
    );
  }
}

// ── summary ──────────────────────────────────────────────────────────────────

console.log('\n┌─────────────────────────────────────────────┐');
console.log('│        FRONTEND BUNDLE BUDGET REPORT        │');
console.log('└─────────────────────────────────────────────┘');
console.log(report.join('\n'));
console.log('');

if (failures > 0) {
  console.error(`✗ ${failures} budget check(s) FAILED. Fix the regressions before merging.\n`);
  process.exit(1);
} else {
  console.log(`✓ All budget checks passed.\n`);
  process.exit(0);
}
