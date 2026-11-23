import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const config = JSON.parse(readFileSync(new URL('../aleph.config.json', import.meta.url), 'utf8'));
const identityPath = 'public/aleph.json';
const bundlePath = 'node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js';
const metadata = {
  VERCEL_GIT_PROVIDER: 'github', VERCEL_GIT_REPO_OWNER: 'youngjinphys',
  VERCEL_GIT_REPO_SLUG: 'Claire', VERCEL_GIT_COMMIT_SHA: 'a'.repeat(40),
  VERCEL_URL: 'claire-synthetic-build.vercel.app',
};

function withBuild(run) {
  const cwd = mkdtempSync(join(tmpdir(), 'claire-public-build-'));
  try {
    for (const directory of ['scripts', 'public', 'node_modules/@simplewebauthn/browser/dist/bundle']) {
      mkdirSync(join(cwd, directory), { recursive: true });
    }
    for (const name of ['build-public.mjs', 'deployment-identity.mjs', 'config-contract.mjs']) {
      copyFileSync(new URL(`../scripts/${name}`, import.meta.url), join(cwd, 'scripts', name));
    }
    writeFileSync(join(cwd, 'aleph.config.json'), JSON.stringify(config));
    writeFileSync(join(cwd, bundlePath), '// synthetic browser bundle\n');
    writeFileSync(join(cwd, 'public', 'preserved.txt'), 'existing unrelated file');
    const build = (args = [], env = metadata) => {
      const child = spawnSync(process.execPath, ['scripts/build-public.mjs', ...args], {
        cwd, encoding: 'utf8', timeout: 15000, env: { ...process.env, ...env },
      });
      assert.ifError(child.error);
      return child;
    };
    run({ cwd, build });
    assert.equal(readFileSync(join(cwd, 'public', 'preserved.txt'), 'utf8'), 'existing unrelated file');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}

test('production followed by a local build removes the old deployment identity only', () => {
  withBuild(({ cwd, build }) => {
    const first = build();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(readFileSync(join(cwd, identityPath), 'utf8')).commit, metadata.VERCEL_GIT_COMMIT_SHA);
    const local = build(['--local']);
    assert.equal(local.status, 0, local.stderr);
    assert.equal(existsSync(join(cwd, identityPath)), false);
    assert.deepEqual(JSON.parse(readFileSync(join(cwd, 'public/data.json'), 'utf8')), { notes: [] });
    const next = build([], { ...metadata, VERCEL_GIT_COMMIT_SHA: 'b'.repeat(40) });
    assert.equal(next.status, 0, next.stderr);
    assert.equal(JSON.parse(readFileSync(join(cwd, identityPath), 'utf8')).commit, 'b'.repeat(40));
  });
});

for (const failure of ['config', 'dependency', 'stage', 'metadata']) {
  test(`failed ${failure} build never leaves a previous production identity`, () => {
    withBuild(({ cwd, build }) => {
      const initial = build();
      assert.equal(initial.status, 0, initial.stderr);
      if (failure === 'config') writeFileSync(join(cwd, 'aleph.config.json'), '{');
      if (failure === 'dependency') rmSync(join(cwd, bundlePath));
      if (failure === 'stage') writeFileSync(join(cwd, 'aleph.config.json'), JSON.stringify({ ...config, step: 99 }));
      const result = build([], failure === 'metadata' ? { ...metadata, VERCEL_GIT_COMMIT_SHA: 'invalid' } : metadata);
      assert.notEqual(result.status, 0);
      assert.equal(existsSync(join(cwd, identityPath)), false);
    });
  });
}
