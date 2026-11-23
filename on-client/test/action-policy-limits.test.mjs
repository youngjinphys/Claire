import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createActionService} from '../src/actions/service.mjs';
import {readActionStartupConfiguration,ACTION_STARTUP_SCHEMA} from '../src/actions/action-startup-config.mjs';

const basePolicy={appId:'aleph-on',audience:'on-client',accessPolicyId:'fixture-policy',allowedActions:['device:revoke'],confirmationTtlMs:60000,timeoutMs:10000};
function fixture(t){
  const root=realpathSync.native(mkdtempSync(join(tmpdir(),'alekov-policy-limits-')));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const databasePath=join(root,'fixture.sqlite'),configPath=join(root,'startup.json');
  const db=new DatabaseSync(databasePath);db.exec('CREATE TABLE fixture (id INTEGER PRIMARY KEY)');db.close();
  const configure=policy=>{writeFileSync(configPath,JSON.stringify({schema:ACTION_STARTUP_SCHEMA,databasePath,policy})+'\n');return readActionStartupConfiguration(configPath);};
  return {databasePath,configure};
}
test('action timeout overflow and unbounded confirmation windows are rejected before identity, engine, or DB effects',async t=>{
  const {databasePath,configure}=fixture(t),before=readFileSync(databasePath);let identities=0,engineReads=0;
  const engine={get evidenceMode(){engineReads++;throw Error('Invalid policy must be rejected first');}};
  const cases=[['timeoutMs',null],['timeoutMs','10000'],['timeoutMs',false],['timeoutMs',0],['timeoutMs',-1],['timeoutMs',1.5],['timeoutMs',120001],['timeoutMs',2147483648],['timeoutMs',Number.MAX_SAFE_INTEGER],
    ['confirmationTtlMs',null],['confirmationTtlMs',0],['confirmationTtlMs',-1],['confirmationTtlMs',1.5],['confirmationTtlMs',3600001],['confirmationTtlMs',Number.MAX_SAFE_INTEGER]];
  for(const [key,value] of cases){
    const policy={...basePolicy,[key]:value};
    const service=createActionService({engine,resolveContext:()=>{identities++;},databasePath,policy});
    const result=await service.prepare({eventId:'event',actionId:'device:revoke'});
    assert.equal(result.error.code,'ACTION_UNSUPPORTED',`${key}=${value}`);
    assert.throws(()=>configure(policy),{code:'INVALID_ACTION_STARTUP_CONFIGURATION'},`${key}=${value}`);
  }
  for(const value of [undefined,NaN,Infinity,-Infinity]){
    const service=createActionService({engine,resolveContext:()=>{identities++;},databasePath,policy:{...basePolicy,timeoutMs:value}});
    assert.equal((await service.prepare({eventId:'event',actionId:'device:revoke'})).error.code,'ACTION_UNSUPPORTED');
  }
  assert.equal(identities,0);assert.equal(engineReads,0);assert.deepEqual(readFileSync(databasePath),before);
});
test('startup and service accept the same inclusive duration bounds and optional timeout default',async t=>{
  const {databasePath,configure}=fixture(t);
  const engine={evidenceMode:'connected',readEvents:async()=>[],authorizeAction:async()=>null,executeAction:async()=>null,readActionResult:async()=>null};
  for(const policy of [{...basePolicy,timeoutMs:1,confirmationTtlMs:1},{...basePolicy,timeoutMs:120000,confirmationTtlMs:3600000},
    Object.fromEntries(Object.entries(basePolicy).filter(([key])=>key!=='timeoutMs'))]){
    assert.deepEqual(configure(policy).sdpActionStartup.policy,policy);
    const service=createActionService({engine,resolveContext:async()=>null,databasePath,policy});
    const result=await service.prepare({eventId:'event',actionId:'device:revoke'});
    assert.equal(result.mode,'connected','Inclusive duration bounds must configure the service');
    assert.ok(['ACTION_SCOPE_UNVERIFIED','ACTION_TIMEOUT'].includes(result.error.code),'A valid 1 ms budget may expire before identity validation completes');
  }
});
