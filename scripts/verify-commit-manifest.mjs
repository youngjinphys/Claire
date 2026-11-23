import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gitEnvironmentForCwd } from './git-context.mjs';

const MANIFEST = 'package/commit-files.json';
const SHA = /^[a-f0-9]{40}$/u;

export function verifyCommitManifest({ cwd = process.cwd(), commit, env = process.env } = {}) {
  // Workflow event values are data, never interpolated into a shell program.
  // Accept an exact object ID, not a ref, revision expression or Git option.
  if (typeof commit !== 'string' || !SHA.test(commit)) throw new Error('INVALID_SOURCE_COMMIT');
  const gitEnv = gitEnvironmentForCwd(env);
  const git = args => execFileSync('git', args, {
    cwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    env: gitEnv,
  });
  let actual;
  let content;
  try {
    if (git(['rev-parse', '--verify', `${commit}^{commit}`]).trim() !== commit) {
      throw new Error('SOURCE_COMMIT_MISMATCH');
    }
    content = git(['show', `${commit}:${MANIFEST}`]);
    actual = git(['diff', '--name-only', '--no-renames', '-z', `${commit}^`, commit, '--'])
      .split('\0').filter(Boolean).sort();
  } catch {
    throw new Error('SOURCE_COMMIT_OR_PARENT_UNAVAILABLE');
  }
  let manifest;
  try { manifest = JSON.parse(content); }
  catch { throw new Error('INVALID_COMMIT_MANIFEST'); }
  const files = manifest?.files;
  if (manifest?.schema !== 'claire.commit-files.v1' || !Array.isArray(files)
      || !files.includes(MANIFEST)
      || files.some(file => typeof file !== 'string' || !file
        || /[\\\x00-\x1f\x7f]/u.test(file) || /^[A-Za-z]:/u.test(file)
        || file.split('/').some(part => !part || part === '.' || part === '..'))
      || JSON.stringify(files) !== JSON.stringify([...new Set(files)].sort())) {
    throw new Error('INVALID_COMMIT_MANIFEST');
  }
  if (JSON.stringify(files) !== JSON.stringify(actual)) throw new Error('COMMIT_FILES_MISMATCH');
  return { commit, files: [...files] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('SOURCE_COMMIT_REQUIRED');
    const result = verifyCommitManifest({ commit: process.argv[2] });
    console.log(`Verified ${result.files.length} changed files for source commit ${result.commit}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
