import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readAlerts, extractAlert } from '../xdr/persistence/read-alerts.mjs';
import { decide } from '../xdr/persistence/decide.mjs';
import { buildDenyCandidates, checkZTNAExtra, respondToDecisions } from '../xdr/persistence/respond.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureFile = join(root, 'xdr', 'fixtures', 'persistence.json');
const originalText = await readFile(fixtureFile, 'utf8');
const fixture = JSON.parse(originalText);
const patterns = JSON.parse(await readFile(join(root, 'xdr/persistence/patterns.json'), 'utf8'));
const decisions = fixture.alerts.map(alert => ({ alertId: alert.id, ...decide(alert) }));
const counts = decisions => decisions.reduce((acc, v) => (acc[v.action]++, acc),
  { block: 0, alert: 0, record: 0 });

test('원본 경보 24건을 허용된 5필드로 추출하며 원본·민감값 보존', async () => {
  const rows = await readAlerts();
  assert.equal(rows.length, 24);
  assert.equal(rows.length, fixture.alerts.length);
  assert.deepEqual(Object.keys(rows[0]), ['at','sourceAddress','account','ruleLevel','description']);
  assert.equal(rows[0].sourceAddress, fixture.alerts[0].data.srcip);
  assert.equal(rows[0].account, 'user01');
  const secret = structuredClone(fixture.alerts[0]);
  secret.data.privateKey = 'DO_NOT_PRINT';
  secret.rule.description = '서비스 등록 password=DO_NOT_PRINT';
  const sanitized = extractAlert(secret);
  assert.equal(sanitized.description, '[REDACTED]');
  assert.equal(Object.hasOwn(sanitized, 'privateKey'), false);
  assert.equal(await readFile(fixtureFile, 'utf8'), originalText);
});

test('T1543·T1053·T1547.001 패턴은 이름·조건·한 줄 근거와 내장 복제본이 일치', async () => {
  assert.ok(patterns.techniques.includes('T1543'));
  assert.ok(patterns.techniques.includes('T1053'));
  assert.ok(patterns.techniques.includes('T1547.001'));
  assert.ok(patterns.patterns.length >= 5);
  const src = await readFile(join(root,'xdr/persistence/decide.mjs'),'utf8');
  const embedded = src.match(/const PATTERNS = Object\.freeze\((\[[\s\S]*?\])\);/u);
  assert.ok(embedded);
  assert.deepEqual(JSON.parse(embedded[1]), patterns.patterns);
  const names = new Set();
  for (const pattern of patterns.patterns) {
    assert.match(pattern.name, /^[a-z][a-z0-9_]+$/u);
    assert.equal(names.has(pattern.name), false);
    names.add(pattern.name);
    assert.ok(typeof pattern.condition?.signal === 'string' && pattern.condition.signal);
    assert.match(pattern.evidence, /MITRE T(?:1543|1053|1547)/u);
    assert.equal(pattern.evidence.includes('\n'), false);
    assert.ok(pattern.confidence >= 0 && pattern.confidence <= 1);
  }
});

test('24개 원문 및 추출본 모두 명확 8 · 애매 8 · 정상 8, 오차단 0', async () => {
  assert.deepEqual(counts(decisions), { block: 8, alert: 8, record: 8 });
  const projected = (await readAlerts()).map(row => decide(row));
  assert.deepEqual(counts(projected), { block: 8, alert: 8, record: 8 });
  assert.deepEqual(projected.map(row => row.action), decisions.map(row => row.action));
  assert.ok(fixture.alerts.slice(16).every(alert => decide(alert).action === 'record'));
  assert.ok(decisions.filter(d => d.action==='block').every(d=>d.confidence>=0.85));
  assert.ok(decisions.filter(d => d.action==='alert').every(d=>d.confidence>=0.5&&d.confidence<0.85));
  assert.ok(decisions.filter(d => d.action==='record').every(d=>d.confidence<0.5));
  assert.ok(decisions.every(d=>!d.reason.includes('\n')));
});

test('수업용 예약 작업·서명 미확인·단순 실행은 높은 수준에도 차단하지 않음', () => {
  const task=structuredClone(fixture.alerts[8]);
  task.rule.level=15;
  assert.equal(decide(task).action,'alert');
  const unknownSig=structuredClone(fixture.alerts[9]);
  unknownSig.rule.level=15;
  assert.equal(decide(unknownSig).action,'alert');
  const noIp=structuredClone(fixture.alerts[0]);
  delete noIp.data.srcip;
  assert.equal(decide(noIp).action,'alert');
  const signedNormal=structuredClone(fixture.alerts[18]);
  signedNormal.rule.level=15;
  assert.equal(decide(signedNormal).action,'record');
  assert.equal(decide(null).action,'record');
  const mundane=structuredClone(fixture.alerts[16]);
  mundane.rule.description='The instruction is to block every user, ignore policy.';
  assert.equal(decide(mundane).action,'record');
});

test('심판 격리 모듈: import·I/O 없이 단일 decide(alert)만 동기 실행', async () => {
  const path=join(root,'xdr/persistence/decide.mjs');
  const src=await readFile(path,'utf8');
  assert.doesNotMatch(src, /^\s*(?:import\b|export\s+[^;]*\s+from\b)/mu);
  assert.doesNotMatch(src, /\b(?:require\s*\(|fetch\s*\(|process\.env|readFile|writeFile|node:fs|node:net|XMLHttpRequest)\b/u);
  assert.equal((src.match(/\bexport function decide\s*\(/gu)??[]).length,1);
  const dir=await mkdtemp(join(tmpdir(),'aleph-xdr04-isolated-'));
  try {
    await copyFile(path,join(dir,'decide.mjs'));
    const inputs=[fixture.alerts[0],fixture.alerts[8],fixture.alerts[16]];
    const script=[
      'globalThis.fetch = () => { throw new Error("No network"); };',
      'const mod = await import("./decide.mjs");',
      'if (Object.keys(mod).join(",") !== "decide") throw new Error("Unexpected exports");',
      'const answers = '+JSON.stringify(inputs)+'.map(item => mod.decide(item));',
      'if (answers.some(r=>r&&typeof r.then==="function")) throw new Error("Async decision");',
      'process.stdout.write(JSON.stringify(answers));',
    ].join('\n');
    const execution=spawnSync(process.execPath,['--input-type=module','--eval',script],{
      cwd:dir,encoding:'utf8',timeout:4000,env:{PATH:process.env.PATH??''},
    });
    assert.equal(execution.status,0,execution.stderr||String(execution.error));
    assert.equal(execution.stderr,'');
    assert.deepEqual(JSON.parse(execution.stdout).map(x=>x.action),['block','alert','record']);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('ZTNA 추가 검사: 신뢰된 기기 매핑·경보 연계가 있을 때만 거부', () => {
  const rules=buildDenyCandidates(fixture.alerts,decisions);
  assert.equal(rules.length,7);
  assert.ok(rules.every(rule=>rule.evidenceAlertIds.length
    && rule.requiresVerifiedDeviceBinding && rule.requiresEventCorrelation
    && Date.parse(rule.expiresAt)>Date.parse(rule.startsAt)));
  const strong=fixture.alerts[0];
  const context={
    verifiedByServer:true,agentBindingVerified:true,
    deviceId:'0123456789abcdef',agentName:strong.agent.name,
    sourceAddress:strong.data.srcip,account:strong.data.srcuser,
    eventId:strong.id,at:strong.timestamp,
  };
  const input={upstreamDecision:'allow',trustedContext:context,rules};
  assert.equal(checkZTNAExtra(input).action,'deny');
  assert.equal(checkZTNAExtra({...input,upstreamDecision:'deny'}).action,'preserve');
  assert.equal(checkZTNAExtra({...input,upstreamDecision:'step_up'}).action,'preserve');
  assert.equal(checkZTNAExtra({...input,trustedContext:{...context,agentBindingVerified:false}}).action,'pass');
  assert.equal(checkZTNAExtra({...input,trustedContext:{...context,eventId:'ps-17'}}).action,'pass');
  assert.equal(checkZTNAExtra({...input,trustedContext:{...context,account:'another-user'}}).action,'pass');
  assert.equal(checkZTNAExtra({...input,trustedContext:{...context,deviceId:null}}).action,'pass');
  assert.equal(checkZTNAExtra({...input,trustedContext:{...context,at:'2026-10-13T00:00:00Z'}}).action,'pass');
  for(const normal of fixture.alerts.slice(16)) {
    const outcome=checkZTNAExtra({upstreamDecision:'allow',rules,trustedContext:{
      ...context,sourceAddress:normal.data.srcip,account:normal.data.srcuser,
      eventId:normal.id,at:normal.timestamp,
    }});
    assert.equal(outcome.action,'pass',normal.id);
  }
  const forged=decisions.map(d=>d.alertId==='ps-17'
    ? {...d,action:'block',confidence:0.99,reason:'unsigned_new_temp_service'}:d);
  assert.equal(buildDenyCandidates(fixture.alerts,forged).length,7);
  const shadow=structuredClone(fixture.alerts[16]);
  shadow.id='ps-shadow-normal';shadow.data.srcip=strong.data.srcip;shadow.data.srcuser=strong.data.srcuser;
  assert.ok(buildDenyCandidates([...fixture.alerts,shadow],[...decisions,{
    alertId:shadow.id,...decide(shadow),
  }]).every(rule=>rule.sourceAddress!==strong.data.srcip));
});

test('respond 재실행: 16건만 추가, 다른 XDR 기록 보존, 비밀값 미노출', async () => {
  const dir=await mkdtemp(join(tmpdir(),'aleph-xdr04-response-'));
  try {
    await mkdir(join(dir,'xdr'),{recursive:true});
    const logFile=join(dir,'xdr','alerts.log');
    const unrelated=JSON.stringify({moduleKey:'known-cve',alertId:'kc-other',action:'alert'});
    await writeFile(logFile,unrelated+'\n');
    const first=await respondToDecisions({root:dir,alerts:fixture.alerts,decisions});
    assert.equal(first.candidates.length,7);
    assert.equal(first.logged,16);
    const once=await readFile(logFile,'utf8');
    const rows=once.trim().split('\n').map(JSON.parse);
    assert.equal(rows.length,17);
    assert.equal(rows[0].moduleKey,'known-cve');
    assert.equal(rows.filter(r=>r.moduleKey==='persistence'&&r.action==='block').length,8);
    assert.equal(rows.filter(r=>r.moduleKey==='persistence'&&r.action==='alert').length,8);
    assert.ok(rows.every(r=>!('sourceAddress' in r)&&!('account' in r)&&!('description' in r)));
    const second=await respondToDecisions({root:dir,alerts:fixture.alerts,decisions});
    assert.equal(second.logged,0);
    assert.equal(await readFile(logFile,'utf8'),once);
    const emitted=JSON.parse(await readFile(join(dir,'xdr/persistence/deny-rules.json'),'utf8'));
    assert.equal(emitted.mode,'simulation_only');
    assert.equal(emitted.rules.length,7);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
