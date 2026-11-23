import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitEnvironmentForCwd } from '../../scripts/git-context.mjs';

export function withHistory(run, { environment = process.env, parent = tmpdir(), bare = true } = {}) {
  const directory = mkdtempSync(join(parent, 'claire-manifest-history-'));
  const cwd = join(directory, bare ? 'repository.git' : 'checkout');
  try {
    mkdirSync(cwd);
    const configFile = join(directory, 'empty.gitconfig');
    writeFileSync(configFile, '');
    const env = {
      ...gitEnvironmentForCwd(environment, { configFile }),
      GIT_AUTHOR_NAME: 'Fixture', GIT_COMMITTER_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
    };
    const git = (args, input) => execFileSync('git', args, {
      cwd, env, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], timeout: 10_000,
    }).trim();
    git(['init', ...(bare ? ['--bare'] : []), '--quiet', '--template=', '--object-format=sha1']);
    function tree(files) {
      const directories = new Map();
      const entries = [];
      for (const [name, content] of Object.entries(files)) {
        const slash = name.indexOf('/');
        if (slash === -1) entries.push(`100644 blob ${git(['hash-object', '-w', '--stdin'], content)}\t${name}`);
        else {
          const directory = name.slice(0, slash);
          if (!directories.has(directory)) directories.set(directory, {});
          directories.get(directory)[name.slice(slash + 1)] = content;
        }
      }
      for (const [name, children] of directories) entries.push(`040000 tree ${tree(children)}\t${name}`);
      return git(['mktree'], entries.sort().join('\n') + '\n');
    }
    const commit = (files, parents = []) => git(['commit-tree', tree(files),
      ...parents.flatMap(parent => ['-p', parent]), '-m', 'Synthetic fixture']);
    // Only object creation: no named branch, checkout, remote, or shared index.
    run({ directory, cwd, gitDir: bare ? cwd : join(cwd, '.git'), env, git, commit });
    assert.equal(git(['for-each-ref', '--format=%(refname)', 'refs/heads']), '');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
