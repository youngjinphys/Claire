import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const operations = readFileSync(new URL('../public/operations.css', import.meta.url), 'utf8');
const theme = readFileSync(new URL('../public/observatory-theme.css', import.meta.url), 'utf8');

test('operations hero keeps a readable title column when the status line is long', () => {
  assert.match(operations, /\.hero > div:first-child \{[^}]*min-width:0/u);
  assert.match(operations, /\.hero-actions \{[^}]*min-width:0/u);
  assert.match(operations, /\.hero-actions \{[^}]*width:min\(22rem, 100%\)/u);
  assert.match(operations, /#ops-state \{[^}]*align-self:stretch/u);
  assert.doesNotMatch(operations, /\.hero-actions \{[^}]*flex-shrink:\s*0/u);
});

test('operations hero stacks while the side rail still takes width', () => {
  assert.match(operations, /@media\(max-width:900px\) \{\s*\.hero > div:first-child \{ flex:1 1 auto; width:100% \}/u);
  assert.match(operations, /@media\(max-width:900px\) \{[\s\S]*?\.hero-actions \{[^}]*flex:0 1 auto;[^}]*width:100%/u);
  assert.match(theme, /@media\(max-width:900px\) \{\s*\.hero \{ align-items:flex-start; flex-direction:column; min-height:auto \}/u);
  assert.match(theme, /@media\(max-width:900px\) \{[\s\S]*?\.hero-orbit \{[^}]*opacity:\.22/u);
});

test('narrow operations navigation keeps every section link', () => {
  assert.match(operations, /\.mainnav a \{[^}]*white-space:nowrap/u);
  assert.doesNotMatch(operations, /mainnav a:nth-child\(n\+3\)/u);
  assert.match(operations, /\.mainnav \{ order:3; flex:1 1 100%; height:auto; min-width:0; flex-wrap:wrap \}/u);
  assert.match(operations, /\.hint \{[^}]*width:24px; height:24px/u);
  assert.match(theme, /max-width:730px/u);
});
