import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { gitEnvironmentForCwd } from '../scripts/git-context.mjs';
import { verifyCommitManifest } from '../scripts/verify-commit-manifest.mjs';
import { withHistory } from './helpers/git-history.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const verifier = fileURLToPath(new URL('../scripts/verify-commit-manifest.mjs', import.meta.url));
const originalTests = fileURLToPath(new URL('./commit-manifest.test.mjs', import.meta.url));
const manifestPath = 'package/commit-files.json';
const manifest = files => JSON.stringify({ schema: 'claire.commit-files.v1', files: [...files].sort() });
const digest = value => createHash('sha256').update(value).digest('hex');
const environmentDigest = () => digest(JSON.stringify(Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b))));

function snapshot(directory) {
  const entries = [];
  function visit(relative = '') {
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isDirectory()) {
        entries.push([path, 'directory']);
        visit(path);
      } else {
        assert.ok(entry.isFile(), 'Synthetic preservation target must contain only files and directories');
        entries.push([path, digest(readFileSync(join(directory, path)))]);
      }
    }
  }
  visit();
  return entries;
}

function withOutsideRepository(run) {
  const directory = mkdtempSync(join(tmpdir(), 'claire-git-boundary-'));
  const environmentBefore = environmentDigest();
  try {
    const outside = join(directory, 'outside.git');
    const worktree = join(directory, 'outside-worktree');
    const temporary = join(directory, 'fixture-tmp');
    const emptyConfig = join(directory, 'bootstrap.gitconfig');
    const template = join(directory, 'foreign-template');
    mkdirSync(worktree);
    mkdirSync(temporary);
    mkdirSync(template);
    writeFileSync(join(template, 'template-marker'), 'synthetic template must not enter a history fixture\n');
    writeFileSync(emptyConfig, '');
    // Bootstrap independently of the helper under test. Every possible target
    // is owned by this test; no real Git metadata is used as an outside target.
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^GIT_/iu.test(key) && key.toUpperCase() !== 'NODE_TEST_CONTEXT'));
    Object.assign(environment, {
      GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_SYSTEM: emptyConfig, GIT_CONFIG_NOSYSTEM: '1',
      TMPDIR: temporary, TEMP: temporary, TMP: temporary,
    });
    const git = (args, input) => execFileSync('git', args, {
      cwd: directory, env: environment, input, encoding: 'utf8', timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    git(['init', '--bare', '--quiet', '--template=', '--object-format=sha1', outside]);
    const outsideGit = (args, input) => git([`--git-dir=${outside}`, `--work-tree=${worktree}`, ...args], input);
    const blob = outsideGit(['hash-object', '-w', '--stdin'], 'Synthetic outside object\n');
    outsideGit(['update-ref', 'refs/tags/external-sentinel', blob]);
    outsideGit(['read-tree', '--empty']);
    git(['config', '--file', join(outside, 'config'), 'core.bare', 'false']);
    assert.ok(existsSync(join(outside, 'index')));
    assert.equal(outsideGit(['for-each-ref', '--format=%(refname)', 'refs/heads']), '');
    const before = snapshot(outside);
    run({ directory, outside, worktree, temporary, template, environment, before });
    assert.deepEqual(snapshot(outside), before, 'Outside config, references, index and objects must remain byte-identical');
    assert.equal(environmentDigest(), environmentBefore, 'Global process.env must remain unchanged');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function twoCommits(commit) {
  const baseFiles = { 'base.txt': 'base', [manifestPath]: manifest([manifestPath]) };
  const base = commit(baseFiles);
  return commit({ ...baseFiles, 'next.txt': 'next', [manifestPath]: manifest(['next.txt', manifestPath]) }, [base]);
}

function assertVerifier(cwd, commit, env) {
  assert.deepEqual(verifyCommitManifest({ cwd, commit, env }), { commit, files: ['next.txt', manifestPath] });
  const child = spawnSync(process.execPath, [verifier, commit], {
    cwd, env, encoding: 'utf8', timeout: 10_000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr || String(child.error));
  assert.match(child.stdout, /Verified 2 changed files/u);
}

test('Git environment copies remove case variants of repository and inline-config routing without global mutation', () => {
  const source = Object.freeze({
    Path: 'synthetic-path', SystemRoot: 'synthetic-system',
    GIT_CONFIG_GLOBAL: 'trusted-global-config', GIT_CONFIG_SYSTEM: 'trusted-system-config',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_DIR: 'outside', git_dir: 'outside-lower', Git_Work_Tree: 'outside-worktree',
    Git_Common_Dir: 'outside-common', GIT_INDEX_FILE: 'outside-index',
    GIT_OBJECT_DIRECTORY: 'outside-objects', GIT_ALTERNATE_OBJECT_DIRECTORIES: 'outside-alternates',
    GIT_NAMESPACE: 'outside-namespace', GIT_SHALLOW_FILE: 'outside-shallow', GIT_GRAFT_FILE: 'outside-grafts',
    GIT_REPLACE_REF_BASE: 'refs/outside', GIT_REFERENCE_BACKEND: 'outside-backend',
    GIT_CEILING_DIRECTORIES: 'outside-ceiling', GIT_DISCOVERY_ACROSS_FILESYSTEM: '1',
    GIT_CONFIG: 'outside-config', Git_Config_Count: '2',
    GIT_CONFIG_KEY_0: 'core.worktree', GIT_CONFIG_VALUE_0: 'outside-worktree',
    git_config_key_1: 'include.path', git_config_value_1: 'outside-config',
    GIT_CONFIG_PARAMETERS: 'untrusted-inline-settings',
  });
  const expected = {
    Path: source.Path, SystemRoot: source.SystemRoot,
    GIT_CONFIG_GLOBAL: source.GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM: source.GIT_CONFIG_SYSTEM,
    GIT_CONFIG_NOSYSTEM: source.GIT_CONFIG_NOSYSTEM,
  };
  assert.deepEqual(gitEnvironmentForCwd(source), expected);
  const fixture = gitEnvironmentForCwd(source, { configFile: 'owned-empty-config' });
  assert.deepEqual(fixture, { ...expected, GIT_CONFIG_GLOBAL: 'owned-empty-config', GIT_CONFIG_SYSTEM: 'owned-empty-config' });
  assert.deepEqual(gitEnvironmentForCwd(fixture), fixture, 'Verifier sanitization must retain fixture configuration isolation');
  assert.equal(source.GIT_DIR, 'outside');
  assert.equal(source.Git_Config_Count, '2');
});

test('fixture writes and both verifier entry points ignore external routing and preserve the outside Git store', () => {
  withOutsideRepository(({ outside, worktree, temporary, template, environment, before }) => {
    const cases = [
      { GIT_DIR: outside },
      {
        GIT_DIR: outside, GIT_WORK_TREE: worktree, GIT_COMMON_DIR: outside,
        GIT_INDEX_FILE: join(outside, 'index'), GIT_OBJECT_DIRECTORY: join(outside, 'objects'),
        GIT_ALTERNATE_OBJECT_DIRECTORIES: join(outside, 'objects'), GIT_NAMESPACE: 'outside-namespace',
      },
      { GIT_OBJECT_DIRECTORY: join(outside, 'objects') },
      {
        GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.worktree', GIT_CONFIG_VALUE_0: worktree,
        GIT_CONFIG_KEY_1: 'init.templateDir', GIT_CONFIG_VALUE_1: template,
        GIT_CONFIG_PARAMETERS: "'core.bare=false'", GIT_TEMPLATE_DIR: template, GIT_DEFAULT_HASH: 'sha256',
      },
      {
        git_dir: outside, Git_Work_Tree: worktree, gIt_cOmMoN_dIr: outside,
        git_index_file: join(outside, 'index'), Git_Object_Directory: join(outside, 'objects'),
        Git_Config_Count: '1', git_config_key_0: 'core.worktree', git_config_value_0: worktree,
      },
    ];
    for (const routing of cases) {
      const polluted = Object.freeze({ ...environment, ...routing });
      withHistory(({ directory, cwd, gitDir, env, git, commit }) => {
        // Native resolution expands Windows short-name aliases before comparison.
        const actualDirectory = realpathSync.native(git(['rev-parse', '--absolute-git-dir']));
        const fixtureDirectory = realpathSync.native(gitDir);
        assert.equal(actualDirectory, fixtureDirectory);
        assert.notEqual(actualDirectory, realpathSync.native(outside));
        const alias = join(directory, 'repository-alias');
        symlinkSync(gitDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
        assert.equal(realpathSync.native(alias), fixtureDirectory);
        assert.equal(git(['config', '--get', 'core.bare']), 'true');
        assert.equal(existsSync(join(gitDir, 'template-marker')), false);
        assert.equal(readFileSync(env.GIT_CONFIG_GLOBAL, 'utf8'), '');
        assert.deepEqual(gitEnvironmentForCwd(env), env);
        const sourceCommit = twoCommits(commit);
        assertVerifier(cwd, sourceCommit, env);
        assertVerifier(cwd, sourceCommit, polluted);
      }, { environment: polluted, parent: temporary });
      assert.deepEqual(snapshot(outside), before);
    }
  });
});

test('all three original manifest tests pass with ambient GIT_DIR without modifying outside metadata', () => {
  withOutsideRepository(({ outside, environment }) => {
    const child = spawnSync(process.execPath, ['--test', '--test-reporter=tap', originalTests], {
      cwd: root, env: { ...environment, GIT_DIR: outside }, encoding: 'utf8', timeout: 30_000,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr || child.stdout || String(child.error));
    assert.match(child.stdout, /# tests 3\b/u);
    assert.match(child.stdout, /# pass 3\b/u);
    assert.match(child.stdout, /# fail 0\b/u);
  });
});

for (const bare of [true, false]) {
  test(`source verification preserves ${bare ? 'bare repository' : 'ordinary checkout'} and detached linked-worktree discovery`, () => {
    withOutsideRepository(({ outside, worktree, temporary, environment }) => {
      const polluted = { ...environment, GIT_DIR: outside, GIT_WORK_TREE: worktree, GIT_COMMON_DIR: outside };
      withHistory(({ directory, cwd, gitDir, env, git, commit }) => {
        const sourceCommit = twoCommits(commit);
        writeFileSync(join(gitDir, 'HEAD'), sourceCommit + '\n');
        assertVerifier(cwd, sourceCommit, polluted);
        const linked = join(directory, 'linked');
        git(['worktree', 'add', '--detach', '--no-checkout', linked, sourceCommit]);
        assert.match(readFileSync(join(linked, '.git'), 'utf8'), /^gitdir: /u);
        assertVerifier(linked, sourceCommit, polluted);
        assert.equal(git(['for-each-ref', '--format=%(refname)', 'refs/heads']), '');
        const linkedHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: linked, env, encoding: 'utf8' }).trim();
        assert.equal(linkedHead, sourceCommit);
        assert.equal(readFileSync(join(gitDir, 'HEAD'), 'utf8'), sourceCommit + '\n');
      }, { environment, parent: temporary, bare });
    });
  });
}
