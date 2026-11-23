import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createActionService} from '../src/actions/service.mjs';

const BUDGET=100;
const realNow=performance.now.bind(performance),realSetTimeout=setTimeout,realClearTimeout=clearTimeout;
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const clocks=new WeakMap();
function virtualClock(t){
  if(clocks.has(t))return clocks.get(t);
  let value=0;t.mock.method(performance,'now',()=>value);t.mock.timers.enable({apis:['setTimeout']});
  const clock={advance:()=>{value+=BUDGET;},expire:()=>{value+=BUDGET;t.mock.timers.tick(BUDGET);}};
  clocks.set(t,clock);return clock;
}
async function reachedBeforeCompletion(reached,pending){
  let timer;
  try{await Promise.race([reached.promise,pending.then(result=>{throw Error('Operation completed before the expected boundary: '+JSON.stringify(result));}),
    new Promise((_,reject)=>{timer=realSetTimeout(()=>reject(Error('Expected boundary was not reached')),1500);})]);}
  finally{realClearTimeout(timer);}
}
function fixture(t,{receipts=false,ownReceipt=false,virtualTime=true}={}){
  const time=virtualTime?virtualClock(t):null;
  const root=mkdtempSync(join(tmpdir(),'alekov-action-deadline-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const databasePath=join(root,'fixture.sqlite'),db=new DatabaseSync(databasePath);db.exec('CREATE TABLE fixture (id INTEGER PRIMARY KEY)');db.close();
  const scope={subjectId:'student',projectId:'fixture-project',sessionId:'fixture-session',identityVersion:1,appId:'aleph-on',audience:'on-client',accessPolicyId:'fixture-policy',engineGeneration:1,sourcePolicyVersion:'policy-v1'};
  const event={id:'event',subjectId:scope.subjectId,projectId:scope.projectId,kind:'xdr',at:new Date().toISOString(),summary:'Synthetic test event',evidence:[{id:'evidence',text:'Synthetic evidence'}],rules:[{id:'rule',text:'Synthetic rule'}],
    state:{access:'allowed',session:'active',device:'compliant'},supportedActions:['device:revoke'],target:{id:'device:fixture',generation:1}};
  const hooks={},calls={};let command;
  const invoke=async(name,fallback,...args)=>{calls[name]=(calls[name]??0)+1;return hooks[name]?hooks[name](fallback,...args):fallback(...args);};
  const result=()=>({...Object.fromEntries(['requestId','fingerprint','eventId','actionId','target','snapshotDigest'].map(key=>[key,command[key]])),scope:structuredClone(scope),status:'succeeded',observedAt:new Date().toISOString(),
    effect:{applied:true,operationId:command.requestId,target:structuredClone(command.target),snapshotDigest:command.snapshotDigest}});
  const engine={evidenceMode:'connected',
    readEvents:(...args)=>invoke('readEvents',()=>[structuredClone(event)],...args),
    authorizeAction:(...args)=>invoke('authorizeAction',(input,current)=>({allowed:true,durableOperations:true,context:structuredClone(current),eventId:input.eventId,actionId:input.actionId,target:structuredClone(input.target),snapshotDigest:input.snapshotDigest}),...args),
    executeAction:(...args)=>invoke('executeAction',input=>{command=structuredClone(input);return {status:'accepted'};},...args),
    readActionResult:(...args)=>invoke('readActionResult',result,...args)};
  if(receipts)engine.readActionReceipt=(...args)=>invoke('readActionReceipt',result,...args);
  if(ownReceipt)engine.readOwnRevokedReceipt=(...args)=>invoke('readOwnRevokedReceipt',result,...args);
  const service=(timeoutMs=2000)=>createActionService({engine,databasePath,resolveContext:(...args)=>invoke('resolveContext',()=>structuredClone(scope),...args),
    clock:()=>{calls.clock=(calls.clock??0)+1;return hooks.clock?hooks.clock():Date.now();},
    policy:{appId:'aleph-on',audience:'on-client',accessPolicyId:'fixture-policy',allowedActions:['device:revoke'],confirmationTtlMs:60000,timeoutMs}});
  const safe=service();
  const inspect=requestId=>{
    const connection=new DatabaseSync(databasePath,{readOnly:true});
    try{return {state:connection.prepare('SELECT * FROM alekov_action_state WHERE request_id=?').get(requestId),audit:connection.prepare('SELECT code,status,version FROM alekov_action_audit WHERE request_id=? ORDER BY version').all(requestId)};}
    finally{connection.close();}
  };
  const prepare=async()=>{const prepared=await safe.prepare({eventId:'event',actionId:'device:revoke'});assert.equal(prepared.ok,true);return {requestId:prepared.data.requestId,confirmationId:prepared.data.confirmationId};};
  const dispatch=async()=>{const input=await prepare();const executed=await safe.execute(input);assert.equal(executed.data.status,'pending');return input;};
  const reset=()=>{for(const key of Object.keys(calls))delete calls[key];};
  const late=(fallback,...args)=>{time.advance();return fallback(...args);};
  return {databasePath,hooks,calls,service,safe,inspect,prepare,dispatch,reset,result,time,late};
}

for(const stage of ['resolveContext','readEvents','authorizeAction','clock'])test(`prepare stops after an expired ${stage} before creating an intent`,async t=>{
  const f=fixture(t),before=readFileSync(f.databasePath);f.hooks[stage]=stage==='clock'?()=>{f.time.advance();return Date.now();}:f.late;
  const result=await f.service(BUDGET).prepare({eventId:'event',actionId:'device:revoke'});
  assert.equal(result.ok,false);assert.equal(result.error.code,'ACTION_TIMEOUT');assert.equal(f.calls.executeAction??0,0);
  assert.deepEqual(readFileSync(f.databasePath),before);
});
for(const stage of ['resolveContext','readEvents','authorizeAction','clock'])test(`execute stops after an expired ${stage} before consuming confirmation or dispatching`,async t=>{
  const f=fixture(t),input=await f.prepare(),before=f.inspect(input.requestId);f.reset();f.hooks[stage]=stage==='clock'?()=>{f.time.advance();return Date.now();}:f.late;
  const result=await f.service(BUDGET).execute(input);
  assert.equal(result.ok,false);assert.equal(result.error.code,'ACTION_TIMEOUT');assert.equal(f.calls.executeAction??0,0);
  assert.deepEqual(f.inspect(input.requestId),before);
});
test('a reservation transaction finishing after the deadline remains recorded but cannot dispatch', {timeout:5000},async t=>{
  const f=fixture(t),input=await f.prepare();
  const executeSql=DatabaseSync.prototype.exec;let advanced=false;
  t.mock.method(DatabaseSync.prototype,'exec',function(sql){
    const result=Reflect.apply(executeSql,this,[sql]);
    if(sql==='COMMIT'&&!advanced&&this.prepare('SELECT status FROM alekov_action_state WHERE request_id=?').get(input.requestId)?.status==='reserved'){
      advanced=true;f.time.advance();
    }
    return result;
  });
  f.reset();
  const result=await f.service(BUDGET).execute(input),stored=f.inspect(input.requestId);
  assert.equal(result.ok,true);assert.equal(result.data.status,'unknown');assert.equal(f.calls.executeAction??0,0);
  assert.equal(stored.state.confirmation_consumed,1);assert.equal(stored.state.status,'unknown');
  assert.equal(advanced,true,'Advance only after the actual reserved transaction commits');
  assert.deepEqual(stored.audit.map(row=>row.code),['ACTION_PREPARED','ACTION_DISPATCH_RESERVED','ACTION_TIMEOUT']);
});
test('an acknowledgment returned after synchronous dispatch delay is uncertainty, never a timely pending result',async t=>{
  const f=fixture(t),input=await f.prepare();f.reset();f.hooks.executeAction=f.late;
  const result=await f.service(BUDGET).execute(input),stored=f.inspect(input.requestId);
  assert.equal(result.ok,true);assert.equal(result.data.status,'unknown');assert.equal(f.calls.executeAction,1);
  assert.equal(stored.state.confirmation_consumed,1);assert.equal(stored.state.status,'unknown');
  assert.deepEqual(stored.audit.map(row=>row.code),['ACTION_PREPARED','ACTION_DISPATCH_RESERVED','ACTION_TIMEOUT']);
  delete f.hooks.executeAction;
  const replay=await f.safe.execute(input);assert.equal(replay.data.replayed,true);assert.equal(replay.data.status,'unknown');assert.equal(f.calls.executeAction,1);
});
test('a late dispatch completion cannot overwrite timeout evidence or trigger a retry', {timeout:3000},async t=>{
  const f=fixture(t),input=await f.prepare(),gate=deferred(),reached=deferred();f.reset();
  f.hooks.executeAction=async(fallback,...args)=>{fallback(...args);reached.resolve();return gate.promise;};
  const pending=f.service(BUDGET).execute(input);
  try{
    await reachedBeforeCompletion(reached,pending);f.time.expire();const result=await pending;
    assert.equal(result.data.status,'unknown');const before=f.inspect(input.requestId),reads=f.calls.resolveContext;
    gate.resolve({status:'accepted'});await turn();assert.deepEqual(f.inspect(input.requestId),before);assert.equal(f.calls.resolveContext,reads);assert.equal(f.calls.executeAction,1);
  }finally{gate.resolve({status:'accepted'});await pending;}
});
for(const stage of ['readEvents','authorizeAction','readActionResult'])test(`readResult expiry during ${stage} cannot disclose or modify an existing receipt`,async t=>{
  const f=fixture(t),input=await f.dispatch(),before=f.inspect(input.requestId);f.reset();f.hooks[stage]=f.late;
  const result=await f.service(BUDGET).readResult({requestId:input.requestId});
  assert.equal(result.ok,false);assert.equal(result.error.code,'ACTION_TIMEOUT');assert.equal(result.data,undefined);
  assert.deepEqual(f.inspect(input.requestId),before);assert.equal(f.calls.executeAction??0,0);
  assert.equal(f.calls.readActionResult??0,stage==='readActionResult'?1:0);
});
test('readResult cannot read the engine after its initial identity lookup expires',async t=>{
  const f=fixture(t),input=await f.dispatch(),before=f.inspect(input.requestId);f.reset();f.hooks.resolveContext=f.late;
  const result=await f.service(BUDGET).readResult({requestId:input.requestId});
  assert.equal(result.error.code,'ACTION_TIMEOUT');assert.equal(f.calls.readActionResult??0,0);assert.deepEqual(f.inspect(input.requestId),before);
});
test('consumed receipt expiry cannot publish a succeeded effect or renew authorization',async t=>{
  const f=fixture(t,{receipts:true}),input=await f.dispatch(),before=f.inspect(input.requestId);f.reset();f.hooks.readActionReceipt=f.late;
  const result=await f.service(BUDGET).readResult({requestId:input.requestId});
  assert.equal(result.error.code,'ACTION_TIMEOUT');assert.equal(result.data,undefined);assert.deepEqual(f.inspect(input.requestId),before);
  assert.equal(f.calls.readActionReceipt,1);assert.equal(f.calls.readEvents??0,0);assert.equal(f.calls.authorizeAction??0,0);assert.equal(f.calls.executeAction??0,0);
});
test('identity expiry cannot enter the own-revoked-receipt fallback',async t=>{
  const f=fixture(t,{receipts:true,ownReceipt:true}),input=await f.dispatch(),before=f.inspect(input.requestId);f.reset();
  f.hooks.resolveContext=()=>{f.time.advance();throw Object.assign(Error('unverified'),{code:'ACTION_SCOPE_UNVERIFIED'});};
  const result=await f.service(BUDGET).readResult({requestId:input.requestId});
  assert.equal(result.error.code,'ACTION_TIMEOUT');assert.equal(f.calls.readOwnRevokedReceipt??0,0);assert.equal(f.calls.readActionReceipt??0,0);assert.deepEqual(f.inspect(input.requestId),before);
});
test('own-revoked-receipt expiry supplies no ownership proof and leaves the original receipt unchanged',async t=>{
  const f=fixture(t,{receipts:true,ownReceipt:true}),input=await f.dispatch(),before=f.inspect(input.requestId);f.reset();
  f.hooks.resolveContext=()=>{throw Object.assign(Error('unverified'),{code:'ACTION_SCOPE_UNVERIFIED'});};f.hooks.readOwnRevokedReceipt=f.late;
  const result=await f.service(BUDGET).readResult({requestId:input.requestId});
  assert.equal(result.error.code,'ACTION_TIMEOUT');assert.equal(result.data,undefined);assert.deepEqual(f.inspect(input.requestId),before);
  assert.equal(f.calls.readOwnRevokedReceipt,1);assert.equal(f.calls.executeAction??0,0);
});
test('expired result observation cannot erase newer confirmed ledger evidence', {timeout:3000},async t=>{
  const f=fixture(t),input=await f.dispatch(),gate=deferred(),reached=deferred();f.reset();
  f.hooks.readActionResult=async fallback=>{if(f.calls.readActionResult===1){reached.resolve();return gate.promise;}return fallback();};
  const pending=f.service(BUDGET).readResult({requestId:input.requestId});
  try{
    await reachedBeforeCompletion(reached,pending);
    const confirmed=await f.safe.readResult({requestId:input.requestId});assert.equal(confirmed.data.status,'succeeded');
    f.time.expire();const result=await pending,stored=f.inspect(input.requestId);
    assert.equal(result.error.code,'ACTION_TIMEOUT');assert.equal(result.data,undefined);assert.equal(stored.state.status,'succeeded');
    gate.resolve(f.result());await turn();assert.deepEqual(f.inspect(input.requestId),stored);
  }finally{gate.resolve(f.result());await pending;}
});
test('late identity resolution after timeout creates no intent and starts no later engine stage', {timeout:3000},async t=>{
  const f=fixture(t),before=readFileSync(f.databasePath),gate=deferred(),reached=deferred();f.hooks.resolveContext=()=>{reached.resolve();return gate.promise;};
  const pending=f.service(BUDGET).prepare({eventId:'event',actionId:'device:revoke'});
  try{
    await reachedBeforeCompletion(reached,pending);f.time.expire();const result=await pending;assert.equal(result.error.code,'ACTION_TIMEOUT');
    gate.resolve({});await turn();assert.equal(f.calls.readEvents??0,0);assert.equal(f.calls.authorizeAction??0,0);assert.deepEqual(readFileSync(f.databasePath),before);
  }finally{gate.resolve({});await pending;}
});
test('real-clock synchronous identity starvation cannot create an intent after the deadline',async t=>{
  const f=fixture(t,{virtualTime:false}),before=readFileSync(f.databasePath);
  f.hooks.resolveContext=(fallback,...args)=>{const until=realNow()+160;while(realNow()<until){}return fallback(...args);};
  const result=await f.service(BUDGET).prepare({eventId:'event',actionId:'device:revoke'});
  assert.equal(result.error.code,'ACTION_TIMEOUT');assert.equal(f.calls.executeAction??0,0);assert.deepEqual(readFileSync(f.databasePath),before);
});
test('timely action preparation, dispatch, and effect observation still complete',async t=>{
  for(const receipts of [false,true]){
    const f=fixture(t,{receipts}),input=await f.dispatch(),result=await f.safe.readResult({requestId:input.requestId});
    assert.equal(result.ok,true);assert.equal(result.data.status,'succeeded');assert.equal(result.data.observation.effectApplied,true);assert.equal(f.calls.executeAction,1);
  }
});
