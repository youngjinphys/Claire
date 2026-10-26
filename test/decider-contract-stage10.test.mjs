import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fixtureRequests } from '../scripts/fixture-7.mjs';
import { decide, RULE_IDS } from '../src/decider.mjs';
import { classifyStage10Probe, diagnoseRestore } from '../scripts/recovery-diagnose.mjs';

const FIELDS = Object.freeze([
  'schema','requestId','classId','projectId','subjectId','deviceId',
  'service','method','path','route','queryLength','querySha256',
  'at','policyRevision','deviceRegistered','stepUp','recentEvents','signals',
]);
const EXPECTED_RESPONSE = ['decision','reasonCode','requestId','ruleIds','schema'];
const guarded = source => new Proxy({...source}, {
  get(target, name, receiver) {
    if (typeof name === 'string' && !FIELDS.includes(name))
      throw new Error('NON_CONTRACT_REQUEST_FIELD:' + name);
    return Reflect.get(target,name,receiver);
  },
});

test('가산점: 10단계 설정, 계약상 18필드만 조회, 형식과 RULE_IDS 참조 일치', async () => {
  const config = JSON.parse(await readFile(new URL('../aleph.config.json',import.meta.url),'utf8'));
  const contract = await readFile(new URL('../docs/DECIDER_REQUEST.md',import.meta.url),'utf8');
  assert.ok(Number.isInteger(config.step) && config.step >= 10);
  for (const field of FIELDS) assert.ok(contract.includes(String.fromCharCode(96) + field + String.fromCharCode(96)), field);
  assert.equal(new Set(RULE_IDS).size,RULE_IDS.length);
  const {normal,suspicious} = fixtureRequests();
  const cases = [normal, suspicious,
    {...normal,deviceRegistered:false},
    {...normal,path:'/notes/export'},
    {...normal,method:'PUT',route:'PUT /notes/:id'},
    {...normal,service:'unknown'},
    {...normal,signals:{...normal.signals,source:'none',network:'unknown',region:'unknown'}},
  ];
  for (const req of cases) {
    const result = await decide(guarded(req));
    assert.deepEqual(Object.keys(result).sort(),EXPECTED_RESPONSE);
    assert.equal(result.schema,'aleph.decision.v1');
    assert.equal(result.requestId,req.requestId);
    assert.ok(['allow','deny','step_up'].includes(result.decision));
    assert.ok(typeof result.reasonCode === 'string' && result.reasonCode.length > 0);
    assert.ok(Array.isArray(result.ruleIds) && result.ruleIds.length > 0);
    assert.ok(result.ruleIds.every(id=>RULE_IDS.includes(id)), JSON.stringify(result.ruleIds));
  }
});

test('가산점: 브라우저 조작 role, identity, device 접근 금지', async () => {
  const {normal} = fixtureRequests();
  const forged = {...normal};
  for (const name of ['role','identity','device','geo']) {
    Object.defineProperty(forged,name,{get(){throw Error('FORBIDDEN_ACCESS:' + name);}});
  }
  const response = await decide(guarded(forged));
  assert.equal(response.decision,'allow');
  assert.ok(response.ruleIds.every(id=>RULE_IDS.includes(id)));
});

test('진단: 복원 비활성은 사본·재시험 합격 증거로 기록하지 않음', () => {
  const manifest={step:10,restoreRoute:'/api/restore/notes/:id',
    allowedRoutes:['/api/restore/notes/:id']};
  const result=classifyStage10Probe({
    manifest,manifestStatus:200,restoreStatus:503,restoreError:'RESTORE_DISABLED',
  });
  assert.equal(result.deploymentContractVerified,true);
  assert.equal(result.readiness,'RESTORE_DISABLED');
  assert.equal(result.backupMatch,'not_proven');
  assert.equal(result.restoredReadback,'not_proven');
  assert.equal(result.stages1to9Retested,'not_proven');
  assert.equal(Object.hasOwn(result,'judgeTrace'),false);
});

test('진단: 401도 실제 복원 확인으로 오판하지 않고 비공개 자료를 제외',async()=>{
  const urls=[];
  const manifest={step:10,commit:'a'.repeat(40),restoreRoute:'/api/restore/notes/:id',
    allowedRoutes:['/api/restore/notes/:id']};
  const fakeFetch=async url=>{
    urls.push(new URL(url).pathname);
    if (urls.length===1) return new Response(JSON.stringify(manifest),{status:200});
    return new Response(JSON.stringify({error:'UNAUTHORIZED',
      token:'NEVER_INCLUDE_THIS_TOKEN',noteBody:'NEVER_INCLUDE_THIS_NOTE'}),{status:401});
  };
  const report=await diagnoseRestore({fetcher:fakeFetch,
    baseUrl:'https://student-defense.vercel.app'});
  assert.deepEqual(urls,['/aleph.json',
    '/api/restore/notes/00000000-0000-4000-8000-000000000000']);
  assert.equal(report.readiness,'AUTH_REQUIRED');
  assert.equal(report.manifest.step,10);
  assert.equal(report.anonymousRestore.error,'UNAUTHORIZED');
  assert.equal(report.backupMatch,'not_proven');
  assert.equal(Object.hasOwn(report,'judgeTrace'),false);
  assert.doesNotMatch(JSON.stringify(report),/NEVER_INCLUDE/u);
});

test('진단: 백업 누락·배포 계약 불일치·정상화 여부를 구분', () => {
  const manifest={step:10,restoreRoute:'/api/restore/notes/:id',
    allowedRoutes:['/api/restore/notes/:id']};
  assert.equal(classifyStage10Probe({manifest,manifestStatus:200,restoreStatus:503,
    restoreError:'VERIFIED_BACKUP_NOT_CONFIGURED'}).readiness,'BACKUP_NOT_CONFIGURED');
  assert.equal(classifyStage10Probe({manifest:{...manifest,step:9},
    manifestStatus:200,restoreStatus:503,
    restoreError:'RESTORE_DISABLED'}).readiness,'DEPLOYMENT_CONTRACT_MISMATCH');
  assert.equal(classifyStage10Probe({manifest,manifestStatus:200,restoreStatus:200,
    restoreError:null}).backupMatch,'not_proven');
});
