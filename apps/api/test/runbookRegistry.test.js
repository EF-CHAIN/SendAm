const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const REGISTRY_REL = path.join('docs', 'incidents', 'RUNBOOK-REGISTRY.md');

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
]);

// A document counts as a runbook or drill if it lives under a drills/ folder or
// its top-level heading names it as a runbook, recovery or rollback procedure.
const RUNBOOK_HEADING = /runbook|recovery|rollback|drill/i;

function walkMd(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...walkMd(path.join(dir, entry.name)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.md')) out.push(path.join(dir, entry.name));
  }
  return out;
}

function headingAnchors(file) {
  const text = fs.readFileSync(file, 'utf8');
  const anchors = new Set();
  let inFence = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!match) continue;
    anchors.add(githubSlug(match[2]));
  }
  return anchors;
}

// Mirrors GitHub's heading anchor generation: lowercase, drop punctuation,
// then turn every remaining space into its own hyphen.
function githubSlug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/ /g, '-');
}

function registryLinks() {
  const text = fs.readFileSync(path.join(REPO_ROOT, REGISTRY_REL), 'utf8');
  const links = [];
  const re = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const target = match[2];
    if (/^(https?:|mailto:|#)/i.test(target)) continue;
    const [file, anchor = ''] = target.split('#');
    if (file === '') continue;
    links.push({ label: match[1], file, anchor });
  }
  return links;
}

describe('incident runbook registry', () => {
  test('every relative link resolves to an existing file', () => {
    const baseDir = path.dirname(path.join(REPO_ROOT, REGISTRY_REL));
    const broken = registryLinks()
      .filter(({ file }) => !fs.existsSync(path.resolve(baseDir, file)))
      .map(({ file }) => file);
    assert.deepEqual(broken, []);
  });

  test('every link anchor matches a heading in the target document', () => {
    const baseDir = path.dirname(path.join(REPO_ROOT, REGISTRY_REL));
    const broken = [];
    for (const { file, anchor } of registryLinks()) {
      if (!anchor) continue;
      const target = path.resolve(baseDir, file);
      if (!fs.existsSync(target)) continue; // covered by the file-exists test
      if (!headingAnchors(target).has(anchor)) broken.push(`${file}#${anchor}`);
    }
    assert.deepEqual([...new Set(broken)], []);
  });

  test('every runbook and drill document is linked from the registry', () => {
    const baseDir = path.dirname(path.join(REPO_ROOT, REGISTRY_REL));
    const registryPath = path.join(REPO_ROOT, REGISTRY_REL);

    const docs = walkMd(REPO_ROOT)
      .filter((file) => file !== registryPath)
      .filter((file) => {
        if (file.split(path.sep).includes('drills')) return true;
        const first = fs
          .readFileSync(file, 'utf8')
          .split('\n')
          .find((line) => line.startsWith('# '));
        return Boolean(first) && RUNBOOK_HEADING.test(first);
      })
      .map((file) => path.relative(REPO_ROOT, file));

    assert.ok(
      docs.length > 0,
      'expected to discover at least one runbook/drill document',
    );

    const linked = new Set(
      registryLinks().map(({ file }) =>
        path.relative(REPO_ROOT, path.resolve(baseDir, file)),
      ),
    );

    assert.deepEqual(docs.filter((doc) => !linked.has(doc)), []);
  });
});
