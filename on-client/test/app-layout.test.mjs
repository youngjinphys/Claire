import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
const dashboard = readFileSync(new URL('../public/dashboard.css', import.meta.url), 'utf8');

test('the student app stacks below 1024px instead of forcing a desktop canvas', () => {
  assert.match(css, /body \{ margin: 0; min-width: 320px; word-break: keep-all; overflow-wrap: anywhere; \}/u);
  assert.doesNotMatch(css, /min-width:\s*1024px/u);
  assert.match(css, /@media \(max-width: 1023px\) \{[\s\S]*\.layout \{ grid-template-columns: minmax\(0, 1fr\)/u);
  assert.match(css, /#nav \{ display: flex; flex-direction: column; gap: 4px; \}/u);
  assert.match(dashboard, /word-break:\s*keep-all/u);
});
