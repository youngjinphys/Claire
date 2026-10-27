import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import config from '../aleph.config.json' with {type:'json'};
import {deploymentIdentity} from '../scripts/deployment-identity.mjs';

const canonicalRepo='https://github.com/youngjinphys/Claire';
const env={
  VERCEL_GIT_PROVIDER:'github',
  VERCEL_GIT_REPO_OWNER:'youngjinphys',
  VERCEL_GIT_REPO_SLUG:'Claire',
  VERCEL_GIT_COMMIT_SHA:'a'.repeat(40),
  // Historical Vercel project name is not the Git repository name.
  VERCEL_URL:'choi-bujang-secret-vault-7yjhkjy11.vercel.app',
};

test('checked-in Stage 12 repository, live Git source and public alias are consistent',()=>{
  assert.equal(config.step,12);
  assert.equal(config.repoUrl,canonicalRepo);
  assert.equal(config.publicAppUrl,'https://skt-aleph-defense.vercel.app');
  const manifest=deploymentIdentity(env,config);
  assert.equal(manifest.repoUrl,config.repoUrl);
  assert.equal(manifest.publicAppUrl,config.publicAppUrl);
  assert.equal(manifest.commit,env.VERCEL_GIT_COMMIT_SHA);
  assert.notEqual(manifest.publicAppUrl,'https://'+env.VERCEL_URL);
  assert.equal(deploymentIdentity({...env,VERCEL_GIT_REPO_SLUG:'claire',VERCEL_GIT_REPO_OWNER:'YOUNGJINPHYS'},config).repoUrl,canonicalRepo);
});

test('Stage 12 refuses mismatched or malformed repository identities',()=>{
  for(const badEnv of [
    {...env,VERCEL_GIT_REPO_SLUG:'choi-bujang-secret-vault'},
    {...env,VERCEL_GIT_REPO_OWNER:'unexpected-owner'},
  ]) {
    assert.throws(()=>deploymentIdentity(badEnv,config),/배포 GitHub 저장소/u);
  }
  for(const repoUrl of [
    'https://github.com/youngjinphys/other-repo',
    'https://github.com/unexpected-owner/Claire',
    'https://github.com/youngjinphys/Claire/',
    'https://github.com/youngjinphys/Claire.git',
    'https://github.com/youngjinphys/Claire?x=1',
    'http://github.com/youngjinphys/Claire',
    'https://github.com/youngjinphys/Claire#fragment',
    'https://github.com/youngjinphys/Claire ',
  ]) {
    assert.throws(()=>deploymentIdentity(env,{...config,repoUrl}),/배포 GitHub 저장소/u,repoUrl);
  }
});

test('Stage 1-11 keep their pre-existing Vercel identity contract',()=>{
  const legacy={...config,step:8};
  const legacyEnv={...env,VERCEL_GIT_REPO_OWNER:'Student-A',VERCEL_GIT_REPO_SLUG:'legacy-starter'};
  const result=deploymentIdentity(legacyEnv,legacy);
  assert.equal(result.repoUrl,'https://github.com/student-a/legacy-starter');
  assert.equal(result.publicAppUrl,'https://'+env.VERCEL_URL);
});

test('active local Claire branding and legacy protocol package identity remain compatible',()=>{
  const html=readFileSync(new URL('../on-client/public/index.html',import.meta.url),'utf8');
  const launcher=readFileSync(new URL('../on-client/tools/start-alekov.ps1',import.meta.url),'utf8');
  const pkg=JSON.parse(readFileSync(new URL('../on-client/package.json',import.meta.url),'utf8'));
  assert.match(html,/<title>Claire · ZTNA &amp; XDR<\/title>/u);
  assert.match(html,/<span class="brand-name">Claire <small>/u);
  assert.doesNotMatch(html,/케셰브/u);
  assert.match(launcher,/Say "Claire가 켜졌습니다/u);
  // Internal installer/protocol IDs are not user-facing display names.
  assert.equal(pkg.name,'alekov-client-starter');
  assert.match(launcher,/\$meta\.name -ne 'alekov-client-starter'/u);
});
