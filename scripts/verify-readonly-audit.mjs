import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
assert.equal(process.env.GITHUB_EVENT_NAME, 'push');
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
assert.equal(event.before, git('rev-parse', 'HEAD^'), 'Read-only audit must be a single fast-forward commit');
assert.equal(event.after, git('rev-parse', 'HEAD'));
assert.ok(event.head_commit.message.includes('[readonly-audit]'));
const inventory = JSON.parse(readFileSync('docs/DOCUMENTATION_STATUS.json', 'utf8'));
const allow = new Set([
  ...inventory.documents.filter(d => d.classification === 'current').map(d => d.path),
  'docs/DOCUMENTATION_STATUS.json', 'test/docs-consistency.test.mjs',
  'on-client/student/collect-host.mjs', 'on-client/student/extension.mjs',
  'on-client/src/local-pc-metrics.mjs', 'on-client/public/dashboard-model.mjs',
  'on-client/test/host-collection.test.mjs', 'on-client/test/student-host-view.test.mjs',
  'on-client/test/local-pc-metrics.test.mjs', 'on-client/test/dashboard-regression.test.mjs',
  '.github/workflows/quality.yml', 'scripts/verify-readonly-audit.mjs', 'package/commit-files.json',
]);
const rows = git('diff', '--name-status', '--no-renames', 'HEAD^', 'HEAD').split(/\r?\n/u).filter(Boolean);
const actual = rows.map(row => {
  const [status, path] = row.split('\t');
  assert.ok(['A','M'].includes(status) && allow.has(path), 'Out of scope: ' + row);
  return path;
}).sort();
assert.deepEqual(JSON.parse(readFileSync('package/commit-files.json','utf8')).files, actual);
console.log('Read-only audit scope verified:', actual.length, 'files');
