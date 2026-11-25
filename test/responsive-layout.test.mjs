import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const operations = readFileSync(new URL('../public/operations.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('operations hero wraps the status beside or below a readable title', () => {
  assert.match(operations, /\.hero > div:first-child \{[^}]*min-width:0/u);
  assert.match(operations, /\.hero-actions \{[^}]*min-width:0/u);
  assert.match(operations, /#ops-state \{[^}]*width:100%;[^}]*overflow-wrap:anywhere/u);
  assert.match(operations, /@media\(max-width:900px\) \{\s*\.hero \{ flex-direction:column \}/u);
});

test('one section menu reaches every operations destination in reading order', () => {
  const menus = [...html.matchAll(/<nav\b[^>]*>([\s\S]*?)<\/nav>/gu)];
  assert.equal(menus.length, 1);
  const ids = [...menus[0][1].matchAll(/href="#([^"]+)"/gu)].map(link => link[1]);
  assert.deepEqual(ids, ['overview', 'telemetry', 'evidence', 'redacted', 'runbook', 'vault']);
  for (const id of ids) assert.ok(html.includes('id="' + id + '"'));
});

test('summary values in one row share tracks when a metric label wraps', () => {
  assert.match(operations, /\.metric \{[^}]*grid-template-rows:subgrid/u);
  assert.match(operations, /\.dash-metrics \{ grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/u);
});
