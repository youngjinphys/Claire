import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBundleNotes } from '../scripts/bundle-notes-default.mjs';
import { validateBundleNotes } from '../scripts/bundle-notes-validation.mjs';
import { deploymentIdentity } from '../scripts/deployment-identity.mjs';
import { validateResourceZones } from '../scripts/config-contract.mjs';
import { judgeContractCheck } from '../scripts/judge-contract-check.mjs';

const config=JSON.parse(readFileSync(new URL('../aleph.config.json',import.meta.url),'utf8'));

test('fresh checkout uses a tracked, truthful three-line fallback',()=>{
  const root=mkdtempSync(join(tmpdir(),'aleph-bundle-notes-'));
  try {
    mkdirSync(join(root,'package'));
    const content=readFileSync(new URL('../package/bundle-notes.template.json',import.meta.url));
    writeFileSync(join(root,'package','bundle-notes.template.json'),content);
    const result=loadBundleNotes(root);
    assert.equal(result.origin,'tracked_conservative_template');
    assert.equal(typeof validateBundleNotes(result.notes,10),'string');
    assert.equal(result.notes.explanation.trim().split('\n').length,3);
    assert.match(result.notes.explanation,/미실행/u);
    const user={explanation:'첫 문장은 사용자가 직접 적었습니다.\n둘째 문장에는 시험 범위를 밝힙니다.\n셋째 문장에는 검증되지 않은 결과를 명시합니다.'};
    writeFileSync(join(root,'bundle-notes.json'),JSON.stringify(user));
    assert.deepEqual(loadBundleNotes(root),{origin:'local_bundle_notes',notes:user});
    writeFileSync(join(root,'bundle-notes.json'),'not-json');
    assert.throws(()=>loadBundleNotes(root),SyntaxError);
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
});

test('resource zone configuration persists and stays validated in stages 8-10',()=>{
  const env={
    VERCEL_GIT_PROVIDER:'github',VERCEL_GIT_REPO_OWNER:'student-a',
    VERCEL_GIT_REPO_SLUG:'aleph-defense',
    VERCEL_GIT_COMMIT_SHA:'a'.repeat(40),
    VERCEL_URL:'student-defense-123.vercel.app',
  };
  for(const step of [8,9,10,12]){
    const cfg={...config,step};
    const result=deploymentIdentity(env,cfg);
    assert.deepEqual(result.resourceZones,config.resourceZones);
    assert.deepEqual(validateResourceZones(cfg),config.resourceZones);
    assert.ok(result.allowedRoutes.includes('/api/announcements/:id'));
  }
  const noZones={...config,step:7};
  assert.equal(validateResourceZones(noZones),null);
  assert.ok(!Object.hasOwn(deploymentIdentity(env,noZones),'resourceZones'));
  const reordered={...config,resourceZones:{
    memo:Object.fromEntries(Object.entries(config.resourceZones.memo).reverse()),
    instructorAnnouncement:Object.fromEntries(
      Object.entries(config.resourceZones.instructorAnnouncement).reverse()),
  }};
  assert.deepEqual(validateResourceZones(reordered),config.resourceZones);
  assert.throws(()=>deploymentIdentity(env,{...config,resourceZones:{
    ...config.resourceZones,memo:{...config.resourceZones.memo,apiPath:'/api/notes/export'},
  }}),/허용 경로/u);
});

test('all implemented SDP RULE_IDS have corresponding policy documentation',async()=>{
  const {RULE_IDS}=await import('../src/decider.mjs');
  const policy=readFileSync(new URL('../package/POLICIES.md',import.meta.url),'utf8');
  for(const id of RULE_IDS)assert.ok(policy.includes('| '+String.fromCharCode(96)+id+String.fromCharCode(96)+' |'),id);
});

test('isolated judge-compatible module execution produces contract-compliant results',()=>{
  const report=judgeContractCheck();
  assert.equal(report.contract,'public_training_contract_only');
  assert.equal(report.stage,12);
  assert.equal(report.deciderCases,7);
  assert.equal(report.detectionCases,2);
  assert.deepEqual(Object.keys(report.xdrCounts).sort(),
    ['brute-force','exfiltration','known-cve','persistence','privilege','web-injection']);
  assert.equal(report.productionJudgeResults,'not_verified');
});
