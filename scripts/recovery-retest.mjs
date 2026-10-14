import { spawnSync, execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reportFile = join(root, 'artifacts', 'recovery-retest.json');

// All of these are LOCAL fixtures/mocks. This program neither restores a
// production database nor impersonates the judge or a registered device.
export const TEST_ORDER = Object.freeze([
  {stage:'1-5',name:'existing browser/API and owner boundary',command:'npm',args:['run','test:r5']},
  {stage:'6',name:'registered device allow/deny',command:'node',args:['--test','test/decider-stage6.test.mjs']},
  {stage:'7',name:'verified step-up decisions',command:'node',args:['--test','test/decider-stage7.test.mjs']},
  {stage:'8',name:'resource and instructor-owner boundaries',command:'npm',args:['run','test:zone']},
  {stage:'9',name:'synthetic detection contract',command:'node',args:['--test','test/detect-stage9.test.mjs','test/detect-verified-device-stage9.test.mjs']},
  {stage:'10',name:'backup and restore invariants',command:'npm',args:['run','test:recovery']},
  {stage:'contract',name:'allowed request fields and response rule ids',command:'npm',args:['run','test:decider-contract']},
  {stage:'packaging',name:'starter and submission integrity',command:'npm',args:['run','test:package']},
]);

// Keep production secrets out of child processes and out of diagnostic JSON.
const testEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(?:SUPABASE_|RESTORE_|ALEPH_RECOVERY_|VERCEL_|JEV_)/u.test(key)));

export function sanitizeExitStatus(value) {
  return Number.isInteger(value) && value >= 0 && value < 256 ? value : null;
}

export async function runRecoveryRetest() {
const result = {
  schema:'aleph.recovery.local-retest.v1',
  scope:'local_fixture_only',
  commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
  orderedChecks:[],
  verdict:'not_started',
  liveBackupMatched:'not_run',
  liveBNoteReadback:'not_run',
  liveAAndBAuthorization:'not_run',
  liveRegisteredDeviceTests:'not_run',
  livePostRestoreStages1to9:'not_run',
};

let failed = false;
for(const item of TEST_ORDER) {
  const proc=spawnSync(item.command,item.args,{
    cwd:root,env:testEnvironment,encoding:'utf8',timeout:120000,
    maxBuffer:512*1024,
  });
  const ok=!proc.error && proc.status===0;
  result.orderedChecks.push({
    stage:item.stage,name:item.name,
    status:ok?'passed':'failed',exitCode:sanitizeExitStatus(proc.status),
  });
  if(!ok){
    failed=true;
    // Do not store stdout/stderr: fixture messages can contain note contents.
    console.error('LOCAL_RETEST_FAILED stage='+item.stage);
    break;
  }
}
result.notRunStages=TEST_ORDER.slice(result.orderedChecks.length).map(x=>x.stage);
result.verdict=failed?'failed':'passed_local_only';
await mkdir(dirname(reportFile),{recursive:true});
await writeFile(reportFile,JSON.stringify(result,null,2)+'\n',{encoding:'utf8',mode:0o600});
console.log('Recovery regression: '+result.verdict+
  ' ('+result.orderedChecks.filter(x=>x.status==='passed').length+'/'+TEST_ORDER.length+' checks).');
console.log('Live backup/readback/real-user outcomes remain not_run.');
if(failed)process.exitCode=1;

}
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await runRecoveryRetest();
