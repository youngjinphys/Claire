import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { verifyCommitManifest } from '../scripts/verify-commit-manifest.mjs';
import { withHistory } from './helpers/git-history.mjs';

const script = fileURLToPath(new URL('../scripts/verify-commit-manifest.mjs', import.meta.url));
const manifest = files => JSON.stringify({ schema: 'claire.commit-files.v1', files: [...files].sort() });
const path = 'package/commit-files.json';

test('push and two-commit PR validate the source commit independently of merged HEAD', () => {
  withHistory(({ cwd, env, git, commit }) => {
    const baseFiles = { 'base.txt': 'base', [path]: manifest([path]) };
    const base = commit(baseFiles);
    const firstFiles = { ...baseFiles, 'first.txt': 'first', [path]: manifest(['first.txt', path]) };
    const first = commit(firstFiles, [base]);
    const secondFiles = { ...firstFiles, 'second.txt': 'second', [path]: manifest(['second.txt', path]) };
    const second = commit(secondFiles, [first]);
    assert.deepEqual(verifyCommitManifest({ cwd, env, commit: second }).files, [path, 'second.txt']);

    const newerBase = commit({ ...baseFiles, 'base-change.txt': 'new base',
      [path]: manifest(['base-change.txt', path]) }, [base]);
    const merged = commit({ ...secondFiles, 'base-change.txt': 'new base' }, [newerBase, second]);
    writeFileSync(join(cwd, 'HEAD'), merged + '\n');
    const before = readFileSync(join(cwd, 'HEAD'), 'utf8');
    assert.deepEqual(verifyCommitManifest({ cwd, env, commit: second }), { commit: second, files: [path, 'second.txt'] });
    assert.throws(() => verifyCommitManifest({ cwd, env, commit: merged }), /COMMIT_FILES_MISMATCH/u);
    const mergedDiff = git(['diff', '--name-only', `${merged}^`, merged]);
    assert.ok(mergedDiff.includes('first.txt') && mergedDiff.includes('second.txt'));

    // A working-tree manifest must never substitute for the source commit's blob.
    mkdirSync(join(cwd, 'package'));
    writeFileSync(join(cwd, path), manifest(['forged.txt', path]));
    const child = spawnSync(process.execPath, [script, second], { cwd, env, encoding: 'utf8' });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(readFileSync(join(cwd, 'HEAD'), 'utf8'), before);
  });
});

test('exact validation rejects missing files, duplicate declarations and untrusted revision expressions', () => {
  withHistory(({ cwd, env, commit }) => {
    const baseFiles = { [path]: manifest([path]), 'old.txt': 'old' };
    const base = commit(baseFiles);
    for (const files of [[path], [path, 'new.txt', 'new.txt'], ['../outside', path]]) {
      const next = commit({ ...baseFiles, 'new.txt': 'new', [path]: manifest(files) }, [base]);
      assert.throws(() => verifyCommitManifest({ cwd, env, commit: next }),
        /COMMIT_FILES_MISMATCH|INVALID_COMMIT_MANIFEST/u);
    }
    for (const value of ['HEAD', '--help', 'a'.repeat(40) + '^', 'a'.repeat(40) + '\n', undefined]) {
      assert.throws(() => verifyCommitManifest({ cwd, env, commit: value }), /INVALID_SOURCE_COMMIT/u);
    }
    const changed = commit({ 'new.txt': 'renamed', [path]: manifest(['old.txt', 'new.txt', path]) }, [base]);
    assert.deepEqual(verifyCommitManifest({ cwd, env, commit: changed }).files, ['new.txt', 'old.txt', path]);
  });
});

test('quality workflow checks source SHA for pushes and PRs while testing the default merged checkout', () => {
  function assertWorkflowContract(input) {
    // Git may check out this same YAML with CRLF on Windows.
    const source = input.replace(/\r\n/gu, '\n');
    const linux = source.match(/  test-and-build:\n([\s\S]*?)(?=\n  windows-client:)/u)?.[1];
    assert.ok(linux);
    assert.match(linux, /fetch-depth: 0/u);
    assert.doesNotMatch(linux, /^\s+ref:/mu);
    assert.match(linux, /run: npm test/u);
    const step = linux.match(/      - name: Verify source package\/commit-files\.json[^\n]*\n([\s\S]*?)(?=\n      - name:)/u)?.[1];
    assert.ok(step);
    assert.doesNotMatch(step, /^\s+if:/mu);
    assert.match(step, /SOURCE_COMMIT: \$\{\{ github\.event_name == 'pull_request' && github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/u);
    assert.match(step, /run: node scripts\/verify-commit-manifest\.mjs "\$SOURCE_COMMIT"/u);
  }
  const source = readFileSync(new URL('../.github/workflows/quality.yml', import.meta.url), 'utf8').replace(/\r\n/gu, '\n');
  for (const [ending, input] of [['LF', source], ['CRLF', source.replace(/\n/gu, '\r\n')]]) {
    assert.doesNotThrow(() => assertWorkflowContract(input), `${ending} must preserve the workflow contract`);
    for (const [label, required] of [
      ['source SHA expression', /SOURCE_COMMIT: [^\r\n]+/u],
      ['manifest verification command', /run: node scripts\/verify-commit-manifest\.mjs "\$SOURCE_COMMIT"/u],
    ]) {
      const missing = input.replace(required, '');
      assert.notEqual(missing, input, `Regression fixture must remove ${label}`);
      assert.throws(() => assertWorkflowContract(missing), assert.AssertionError,
        `${ending} must reject a missing ${label}`);
    }
  }
});
