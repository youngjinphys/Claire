import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createActionService} from '../src/actions/service.mjs';
import {createOnServer} from '../src/server.mjs';

const realSetTimeout=setTimeout,realClearTimeout=clearTimeout;
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const fail=(code='ACTION_SCOPE_UNVERIFIED')=>{throw Object.assign(Error('Synthetic ownership refusal'),{code});};
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
async function reachedBeforeCompletion(reached,pending){
  let timer;
  try{await Promise.race([reached.promise,pending.then(result=>{throw Error('Operation completed before ownership read: '+JSON.stringify(result));}),
    new Promise((_,reject)=>{timer=realSetTimeout(()=>reject(Error('Ownership read was not reached')),1500);})]);}
  finally{realClearTimeout(timer);}
}
async function fixture(t,{receipts=true,actionId='device:revoke',virtualTime=true}={}){
  let monotonic=0;
  if(virtualTime){t.mock.method(performance,'now',()=>monotonic);t.mock.timers.enable({apis:['setTimeout']});}
  const root=mkdtempSync(join(tmpdir(),'alekov-receipt-owner-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const databasePath=join(root,'synthetic.sqlite'),db=new DatabaseSync(databasePath);db.exec('CREATE TABLE fixture (id INTEGER PRIMARY KEY)');db.close();
  const scope={subjectId:'owner-a',projectId:'fixture-project',sessionId:'fixture-session',identityVersion:1,appId:'aleph-on',audience:'on-client',accessPolicyId:'fixture-policy',engineGeneration:1,sourcePolicyVersion:'policy-v1'};
  const event={id:'private-event-a',subjectId:scope.subjectId,projectId:scope.projectId,kind:'xdr',at:new Date().toISOString(),summary:'Synthetic event',evidence:[],rules:[],
    state:{access:'allowed',session:'active',device:'compliant'},supportedActions:['device:revoke','grant:remove'],target:{id:'device:fixture-a',generation:1}};
  const policy={appId:'aleph-on',audience:'on-client',accessPolicyId:'fixture-policy',allowedActions:['device:revoke','grant:remove'],confirmationTtlMs:60000,timeoutMs:2000};
  const hooks={},calls={};let command;
  const invoke=async(name,fallback,...args)=>{calls[name]=(calls[name]??0)+1;return hooks[name]?hooks[name](fallback,...args):fallback(...args);};
  const result=()=>({...Object.fromEntries(['requestId','fingerprint','eventId','actionId','target','snapshotDigest'].map(key=>[key,structuredClone(command[key])])),scope:structuredClone(scope),
    status:'succeeded',observedAt:new Date().toISOString(),effect:{applied:true,operationId:command.requestId,target:structuredClone(command.target),snapshotDigest:command.snapshotDigest}});
  const engine={evidenceMode:'connected',
    readEvents:(...args)=>invoke('readEvents',()=>[structuredClone(event)],...args),
    authorizeAction:(...args)=>invoke('authorizeAction',(c,s)=>({allowed:true,durableOperations:true,context:structuredClone(s),eventId:c.eventId,actionId:c.actionId,target:structuredClone(c.target),snapshotDigest:c.snapshotDigest}),...args),
    executeAction:(...args)=>invoke('executeAction',c=>{command=structuredClone(c);return {status:'accepted'};},...args),
    readActionResult:(...args)=>invoke('readActionResult',result,...args),
    readOwnRevokedReceipt:(...args)=>invoke('readOwnRevokedReceipt',result,...args)};
  if(receipts)engine.readActionReceipt=(...args)=>invoke('readActionReceipt',result,...args);
  const resolveContext=(...args)=>invoke('resolveContext',()=>structuredClone(scope),...args);
  const service=(timeoutMs=policy.timeoutMs)=>createActionService({engine,resolveContext,databasePath,policy:{...policy,timeoutMs}});
  const safe=service(),prepared=await safe.prepare({eventId:event.id,actionId});assert.equal(prepared.ok,true);
  const input={requestId:prepared.data.requestId,confirmationId:prepared.data.confirmationId};
  assert.equal((await safe.execute(input)).data.status,'pending');
  const inspect=()=>{const reader=new DatabaseSync(databasePath,{readOnly:true});try{return {
    state:reader.prepare('SELECT * FROM alekov_action_state WHERE request_id=?').get(input.requestId),
    intent:reader.prepare('SELECT * FROM alekov_action_intents WHERE request_id=?').get(input.requestId),
    audits:reader.prepare('SELECT * FROM alekov_action_audit WHERE request_id=? ORDER BY version').all(input.requestId)};
  }finally{reader.close();}};
  for(const key of Object.keys(calls))delete calls[key];
  const before=inspect(),bytes=readFileSync(databasePath);
  const unchanged=()=>{assert.deepEqual(inspect(),before);assert.deepEqual(readFileSync(databasePath),bytes);assert.equal(calls.executeAction??0,0);};
  return {engine,resolveContext,databasePath,policy,scope,input,result,hooks,calls,safe,service,inspect,before,unchanged,
    read:(reader=safe,options)=>reader.readResult({requestId:input.requestId},options),
    advance:()=>{monotonic+=100;},expire:()=>{monotonic+=100;t.mock.timers.tick(100);}};
}
function denied(result,f){
  assert.equal(result.ok,false);assert.equal(result.data,undefined);
  const text=JSON.stringify(result);
  for(const value of [f.input.requestId,f.before.intent.receipt_id,f.before.intent.command_json,'private-event-a','device:fixture-a'])assert.ok(!text.includes(value),'Failure must contain no receipt fields');
  f.unchanged();
}

for(const code of ['ACTION_SCOPE_UNVERIFIED','ACTION_DENIED','SUBJECT_SCOPE_UNVERIFIED','ENGINE_NOT_CONNECTED','ENGINE_RESULT_UNVERIFIED'])test(`own receipt refusal ${code} cannot disclose or reconcile the saved operation`,async t=>{
  const f=await fixture(t);f.hooks.resolveContext=()=>fail();f.hooks.readOwnRevokedReceipt=()=>fail(code);
  denied(await f.read(),f);assert.equal(f.calls.readOwnRevokedReceipt,1);
});
test('absent and malformed own receipts supply no ownership evidence',async t=>{
  const f=await fixture(t);f.hooks.resolveContext=()=>fail();
  for(const value of [undefined,null,{},[],{status:'unknown'},{ok:false,error:{code:'ACTION_DENIED'}}]){
    f.hooks.readOwnRevokedReceipt=()=>value;const result=await f.read();denied(result,f);assert.equal(result.error.code,'ACTION_RESULT_UNVERIFIED');
  }
});
test('every own receipt result binding is required before private metadata or a ledger write',async t=>{
  const f=await fixture(t);f.hooks.resolveContext=()=>fail();
  const mutate=[
    value=>{value.requestId='11111111-1111-4111-8111-111111111111';},value=>{value.fingerprint='incorrect';},value=>{value.eventId='other-event';},
    value=>{value.actionId='grant:remove';},value=>{value.snapshotDigest='incorrect';},value=>{value.target.id='device:other';},value=>{value.target.generation++;},
    ...Object.keys(f.scope).map(key=>value=>{value.scope[key]=typeof value.scope[key]==='number'?value.scope[key]+1:'different';}),
    value=>{value.status='unexpected';},value=>{value.observedAt='not-a-time';},value=>{value.observedAt='1970-01-01T00:00:00.000Z';},value=>{value.observedAt='9999-01-01T00:00:00.000Z';},
    value=>{value.effect=null;},value=>{value.effect.applied=false;},value=>{value.effect.operationId='other';},value=>{value.effect.target.id='device:other';},value=>{value.effect.target.generation++;},
    value=>{value.effect.snapshotDigest='incorrect';},value=>{delete value.effect;},value=>{value.extra=true;},
  ];
  for(const mutation of mutate){
    f.hooks.readOwnRevokedReceipt=()=>{const value=f.result();mutation(value);return value;};
    denied(await f.read(),f);
  }
});
test('a successful but expired own proof cannot disclose or modify the receipt',async t=>{
  const f=await fixture(t);f.hooks.resolveContext=()=>fail();f.hooks.readOwnRevokedReceipt=fallback=>{const value=fallback();f.advance();return value;};
  const result=await f.read(f.service(100));denied(result,f);assert.equal(result.error.code,'ACTION_TIMEOUT');
});
test('a late own proof after timeout cannot change the ledger or disclose a private receipt', {timeout:3000},async t=>{
  const f=await fixture(t),gate=deferred(),reached=deferred();f.hooks.resolveContext=()=>fail();
  f.hooks.readOwnRevokedReceipt=()=>{reached.resolve();return gate.promise;};const pending=f.read(f.service(100));
  try{
    await reachedBeforeCompletion(reached,pending);f.expire();denied(await pending,f);
    gate.resolve(f.result());await turn();f.unchanged();
  }finally{gate.resolve(f.result());await pending;}
});
test('cancellation while acquiring own proof cannot disclose or modify the saved receipt',async t=>{
  const f=await fixture(t),controller=new AbortController();f.hooks.resolveContext=()=>fail();
  f.hooks.readOwnRevokedReceipt=fallback=>{const value=fallback();controller.abort();return value;};
  const result=await f.read(f.safe,{signal:controller.signal});denied(result,f);assert.equal(result.error.code,'ACTION_CANCELLED');
});
test('a non-device action cannot use the own-revoked-device fallback',async t=>{
  const f=await fixture(t,{actionId:'grant:remove'});f.hooks.resolveContext=()=>fail();
  denied(await f.read(),f);assert.equal(f.calls.readOwnRevokedReceipt??0,0);
});
test('without an own receipt reader, missing current identity remains a failure',async t=>{
  const f=await fixture(t);delete f.engine.readOwnRevokedReceipt;f.hooks.resolveContext=()=>fail();
  denied(await f.read(),f);assert.equal(f.calls.readActionReceipt??0,0);
});
for(const status of ['succeeded','unknown'])test(`a fully bound own ${status} receipt permits that observation without re-dispatch`,async t=>{
  const f=await fixture(t);f.hooks.resolveContext=()=>fail();
  f.hooks.readOwnRevokedReceipt=fallback=>{const value=fallback();if(status==='unknown'){value.status='unknown';value.effect=null;}return value;};
  const result=await f.read(),after=f.inspect();
  assert.equal(result.ok,true);assert.equal(result.data.status,status);assert.equal(result.data.eventId,'private-event-a');assert.equal(after.state.status,status);
  assert.equal(after.audits.length,f.before.audits.length+1);assert.equal(after.audits.at(-1).code,'ACTION_RESULT_OBSERVED');
  assert.equal(f.calls.readOwnRevokedReceipt,1);assert.equal(f.calls.executeAction??0,0);assert.equal(f.calls.authorizeAction??0,0);
});
for(const receipts of [false,true]){
  const source=receipts?'readActionReceipt':'readActionResult';
  for(const response of ['success','failure','malformed'])test(`${source}: ${response} followed by failed current identity cannot disclose or reconcile`,async t=>{
    const f=await fixture(t,{receipts});let completed=false;
    f.hooks[source]=fallback=>{completed=true;if(response==='failure')throw Error('Synthetic transport unavailable');return response==='malformed'?null:fallback();};
    f.hooks.resolveContext=fallback=>completed?fail():fallback();
    denied(await f.read(),f);assert.equal(f.calls[source],1);
  });
  test(`${source}: a changed principal during the source read leaves the receipt unchanged`,async t=>{
    const f=await fixture(t,{receipts});let completed=false;
    f.hooks[source]=fallback=>{completed=true;return fallback();};
    f.hooks.resolveContext=fallback=>({...fallback(),...(completed?{subjectId:'other-owner'}:{})});
    const result=await f.read();denied(result,f);assert.equal(result.error.code,'ACTION_SCOPE_CHANGED');
  });
  test(`${source}: a source permission denial is never downgraded to an authorized unknown receipt`,async t=>{
    const f=await fixture(t,{receipts});f.hooks[source]=()=>fail('ACTION_DENIED');
    const result=await f.read();denied(result,f);assert.equal(result.error.code,'ACTION_DENIED');
  });
  test(`${source}: a transport failure can be recorded as unknown after current ownership is reverified`,async t=>{
    const f=await fixture(t,{receipts});let completed=false,checkedAfter=false;
    f.hooks[source]=()=>{completed=true;throw Error('Synthetic transport unavailable');};
    f.hooks.resolveContext=fallback=>{if(completed)checkedAfter=true;return fallback();};
    const result=await f.read(),after=f.inspect();
    assert.equal(checkedAfter,true);assert.equal(result.ok,true);assert.equal(result.data.status,'unknown');assert.equal(after.state.status,'unknown');
    assert.equal(after.audits.at(-1).code,'ACTION_RESULT_UNVERIFIED');assert.equal(f.calls.executeAction??0,0);
  });
}
test('consumed receipt reads allow a changed session while requiring the same current principal',async t=>{
  const f=await fixture(t);f.hooks.resolveContext=fallback=>({...fallback(),sessionId:'new-session',identityVersion:2,engineGeneration:2,sourcePolicyVersion:'policy-v2'});
  const result=await f.read();assert.equal(result.ok,true);assert.equal(result.data.status,'succeeded');assert.equal(f.calls.executeAction??0,0);
});
test('legacy result reads retain full scope continuity across their source read',async t=>{
  const f=await fixture(t,{receipts:false});let completed=false;
  f.hooks.readActionResult=fallback=>{completed=true;return fallback();};
  f.hooks.resolveContext=fallback=>({...fallback(),...(completed?{sessionId:'new-session'}:{})});
  const result=await f.read();denied(result,f);assert.equal(result.error.code,'ACTION_SCOPE_CHANGED');
});
test('the actual local result route rejects failed own-receipt ownership without returning private metadata', {timeout:5000},async t=>{
  const f=await fixture(t,{virtualTime:false});f.hooks.readOwnRevokedReceipt=()=>fail();
  const server=createOnServer({engine:{evidenceMode:'connected',projectId:f.scope.projectId,readIdentity:()=>fail()},
    actionConfiguration:{engine:f.engine,databasePath:f.databasePath,policy:f.policy,resolveContext:()=>fail()}});
  try{
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const origin='http://127.0.0.1:'+server.address().port;
    const response=await fetch(origin+'/api/actions/result',{method:'POST',headers:{origin,'content-type':'application/json'},
      body:JSON.stringify({requestId:f.input.requestId}),signal:AbortSignal.timeout(2000)});
    assert.equal(response.status,403);denied(await response.json(),f);assert.equal(f.calls.readOwnRevokedReceipt,1);
  }finally{await new Promise((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeIdleConnections?.();});}
});
