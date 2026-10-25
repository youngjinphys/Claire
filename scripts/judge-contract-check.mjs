import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureRequests } from './fixture-7.mjs';

const root = resolve(import.meta.dirname, '..');
const xdr = ['brute-force','web-injection','known-cve','persistence','privilege','exfiltration'];

const isolatedCode = [
  "import { readFileSync } from 'node:fs';",
  "import * as m from './module.mjs';",
  "const data = JSON.parse(readFileSync(0, 'utf8'));",
  "let result;",
  "if (data.kind === 'decider') {",
  "  for (const event of data.inputs) {",
  "    for (const forbidden of ['role','identity','device','geo']) {",
  "      Object.defineProperty(event, forbidden, {get() {throw Error('NON_CONTRACT_ACCESS');}});",
  "    }",
  "  }",
  "  result = {ids:m.RULE_IDS,results:await Promise.all(data.inputs.map(x=>m.decide(x)))};",
  "} else if(data.kind === 'detect') {",
  "  result = {results:await Promise.all(data.inputs.map(x=>m.detect(x)))};",
  "} else if(data.kind === 'xdr') {",
  "  result = {results:await Promise.all(data.inputs.map(x=>m.decide(x)))};",
  "} else { throw Error('UNKNOWN_TEST_KIND'); }",
  "console.log(JSON.stringify(result));",
].join('\n');

function runIsolated(path, input) {
  const sandbox = mkdtempSync(join(tmpdir(), 'aleph-isolated-judge-'));
  try {
    writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}\n');
    copyFileSync(join(root,path),join(sandbox,'module.mjs'));
    const result=spawnSync(process.execPath,['--input-type=module','--eval',isolatedCode],{
      cwd:sandbox,input:JSON.stringify(input),encoding:'utf8',timeout:10000,
      maxBuffer:192*1024,env:{
        PATH:process.env.PATH || '',
        NODE_OPTIONS:'--no-warnings',
      },
    });
    assert.equal(result.status,0,'isolated execution failed for '+path+
      '; exit='+result.status);
    return JSON.parse(result.stdout);
  } finally {
    rmSync(sandbox,{recursive:true,force:true});
  }
}

export function judgeContractCheck() {
  const config=JSON.parse(readFileSync(join(root,'aleph.config.json'),'utf8'));
  assert.ok(Number.isInteger(config.step) && config.step >= 10);

  const { normal,suspicious }=fixtureRequests();
  const tests=[
    normal,
    suspicious,
    {...normal,deviceRegistered:false},
    {...normal,path:'/notes/export'},
    {...normal,service:'not_registered'},
    {...normal,method:'PUT',route:'PUT /announcements/:id',
      path:'/announcements/notice-demo'},
    {...normal,method:'PUT',route:'PUT /notes/:id'},
  ];
  const d=runIsolated('src/decider.mjs',{kind:'decider',inputs:tests});
  const validIds=new Set(d.ids);
  assert.equal(validIds.size,d.ids.length);
  const properties=['decision','reasonCode','requestId','ruleIds','schema'];
  assert.equal(d.results.length,tests.length);
  for(let i=0;i<tests.length;i++){
    const row=d.results[i];
    assert.deepEqual(Object.keys(row).sort(),properties);
    assert.equal(row.schema,'aleph.decision.v1');
    assert.equal(row.requestId,tests[i].requestId);
    assert.ok(['allow','deny','step_up'].includes(row.decision));
    assert.ok(typeof row.reasonCode==='string' && row.reasonCode.length>0);
    assert.ok(row.ruleIds.length>0 && row.ruleIds.every(id=>validIds.has(id)));
  }
  assert.deepEqual(d.results.map(x=>x.decision),
    ['allow','step_up','deny','deny','deny','deny','allow']);

  const t0=Date.parse('2026-10-01T00:00:00.000Z');
  const events=(n)=>Array.from({length:n},(_,i)=>({
    at:new Date(t0+2000*i).toISOString(),
    method:'GET',identity:{sub:'learner_fixture'},
  }));
  const detections=runIsolated('src/detect.mjs',{kind:'detect',inputs:[events(120),events(121)]});
  assert.deepEqual(detections.results[0],{action:'observe'});
  assert.deepEqual(detections.results[1],{
    action:'propose_revocation',reasonCode:'burst_read',subject:'learner_fixture',
  });

  const xdrCounts={};
  for(const name of xdr){
    const fixture=JSON.parse(readFileSync(join(root,'xdr','fixtures',name+'.json'),'utf8'));
    const response=runIsolated('xdr/'+name+'/decide.mjs',{
      kind:'xdr',inputs:fixture.alerts,
    });
    assert.equal(response.results.length,fixture.alerts.length,name);
    const counts={block:0,alert:0,record:0};
    for(const decision of response.results){
      assert.deepEqual(Object.keys(decision).sort(),
        ['action','confidence','reason'],name);
      assert.ok(Number.isFinite(decision.confidence)
        && decision.confidence>=0 && decision.confidence<=1,name);
      assert.ok(typeof decision.reason==='string' && decision.reason.length>0,name);
      assert.ok(['block','alert','record'].includes(decision.action),name);
      if(decision.action==='block')assert.ok(decision.confidence>=0.85,name);
      if(decision.action==='alert')assert.ok(decision.confidence>=0.5,name);
      if(decision.action==='record')assert.ok(decision.confidence<0.5,name);
      counts[decision.action]++;
    }
    xdrCounts[name]=counts;
  }
  return {contract:'public_training_contract_only',node:process.version,
    stage:config.step,deciderCases:d.results.length,
    detectionCases:detections.results.length,xdrCounts,
    productionJudgeResults:'not_verified'};
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try {
    const result=judgeContractCheck();
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
  } catch(error) {
    process.stderr.write('JUDGE_COMPAT_FAILURE '+(error?.message||'UNKNOWN')+'\n');
    process.exitCode=1;
  }
}
