import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFileSync(resolve(ROOT, path), 'utf8');
const inventory = JSON.parse(read('docs/DOCUMENTATION_STATUS.json'));
const excludedDirs = new Set(['node_modules', '.git', '.vercel', 'dist', 'build', 'artifacts']);
function trackedMarkdown(dir = ROOT) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !excludedDirs.has(entry.name)) files.push(...trackedMarkdown(resolve(dir, entry.name)));
    else if (entry.isFile() && extname(entry.name) === '.md') files.push(relative(ROOT, resolve(dir, entry.name)).split(sep).join('/'));
  }
  return files;
}
function ownLinks(markdown) {
  const links = [];
  const noFences = markdown.replace(/(^|\n)[ \t]*(?:\x60{3}|~{3})[^\n]*\n[\s\S]*?\n[ \t]*(?:\x60{3}|~{3})[ \t]*(?=\n|$)/gu, '');
  for (const hit of noFences.matchAll(/!?\[[^\]\n]*\]\(([^)\n]+)\)/gu)) {
    let raw = hit[1].trim().replace(/^<|>$/gu, '').split(/\s+(?=["'])/u)[0];
    if (!raw || raw.startsWith('#') || raw.startsWith('/') || /^[a-z][a-z\d+.-]*:/iu.test(raw)) continue;
    raw = raw.split('#')[0];
    if (raw) links.push(raw);
  }
  return links;
}

test('every Markdown file is classified exactly once, preserving source and dated evidence', () => {
  assert.equal(inventory.schema, 'claire.documentation-status.v1');
  const actual = trackedMarkdown().sort();
  const listed = inventory.documents.map(entry => entry.path).sort();
  assert.deepEqual(listed, actual, 'Current Markdown inventory must match the repository');
  assert.equal(actual.length, inventory.existingMarkdownCount);
  assert.equal(new Set(listed).size, listed.length);
  for (const entry of inventory.documents) {
    assert.ok(['current', 'protected', 'historical', 'empty-preserved'].includes(entry.classification), entry.path);
    if (entry.classification === 'empty-preserved') assert.equal(read(entry.path), '');
  }
});

test('living documentation internal links resolve to real repository files or directories', () => {
  const broken = [];
  for (const entry of inventory.documents.filter(row => row.classification === 'current')) {
    const source = read(entry.path);
    for (const raw of ownLinks(source)) {
      let dest;
      try { dest = decodeURIComponent(raw); } catch { broken.push(entry.path + ' -> invalid URL encoding'); continue; }
      const target = resolve(ROOT, dirname(entry.path), dest);
      if (relative(ROOT, target).startsWith('..' + sep) || !existsSync(target)) broken.push(entry.path + ' -> ' + dest);
    }
  }
  assert.deepEqual(broken, [], 'Repair links or reclassify truly historical documents, never invent files');
});

test('living guidance agrees with the actual app, supported runtime and safety boundary', () => {
  const rootPkg = JSON.parse(read('package.json'));
  const appPkg = JSON.parse(read('on-client/package.json'));
  assert.equal(rootPkg.engines.node, appPkg.engines.node);
  assert.ok(appPkg.scripts.start.includes('src/server.mjs'));
  assert.ok(appPkg.scripts.test.includes('test/*.test.mjs'));
  assert.match(read('on-client/README.md'), new RegExp(appPkg.version.replaceAll('.', '\\.')));
  assert.ok(read('README.md').includes(appPkg.engines.node));
  const server = read('on-client/src/server.mjs');
  const extension = read('on-client/student/extension.mjs');
  const collector = read('on-client/student/collect-host.mjs');
  const integrated = read('on-client/public/dashboard.mjs');
  assert.ok(server.includes('/api/local-pc'));
  assert.ok(integrated.includes('/student/extension.mjs'));
  for (const symbol of ['hostReportQuality', 'hostHistoryTransition', 'hostComparison', 'hostPanel', 'buildClaireHostAggregateEvidence']) {
    assert.ok(extension.includes(symbol), symbol);
  }
  for (const symbol of ['readNetwork', 'readFirewall', 'readWindowsEvents', 'saveHostObservation']) assert.ok(collector.includes(symbol));
  assert.ok(read('docs/CURRENT_LIMITATIONS.md').includes('침해나 공격 탐지 결과가 아닙니다'));
  assert.ok(read('on-client/student/HOST_OBSERVATION.md').includes('원본 진위'));
  assert.ok(read('on-client/docs/STUDENT_RUNBOOK.md').includes('System'));
  assert.doesNotMatch(read('docs/README.md'), /현재 안내 기준.*e139029312db2bce069be7ae0052698180d6ac7c/u);
});

test('navigation documents describe the archive without deleting its original bytes', () => {
  for (const record of inventory.historicalCopies) {
    assert.equal(inventory.documents.find(x => x.path === record.path)?.classification, 'historical');
    assert.ok(existsSync(resolve(ROOT, record.path)));
  }
  for (const p of ['AGENTS.md', 'docs/DECIDER_REQUEST.md', 'docs/DETECT_EVENTS.md', 'on-client/vendor/NOTICE.md']) {
    assert.equal(inventory.documents.find(x => x.path === p)?.classification, 'protected');
  }
});
