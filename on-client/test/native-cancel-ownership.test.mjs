import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {getEventListeners} from 'node:events';
import {test} from 'node:test';
import {createNativeLogin,nativePublicError,openNativeOperation,assertNativeOperation,
  closeNativeOperation,issueNativeReceiptTicket,nativeOperationBinding,refreshNativeOperation} from '../src/connection/native-login.mjs';
import {createNativeLoginController,nativeLoginView,validNativeData,NATIVE_CANCEL_UNCONFIRMED_MESSAGE} from '../public/ai-connect.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const hash=value=>createHash('sha256').update(value).digest('base64url');
const canonical={canonicalStudentId:'fixture-student',alephUserId:'fixture-user',siteId:'fixture-site',identityVersion:1};
const handle='nl1_'+'A'.repeat(43),instance='11111111-1111-4111-8111-111111111111';
const errorIs=code=>error=>error?.code===`NATIVE_HOST_${code}`;

function fixture(t,{timeoutMs=1000}={}){
  let wall=100000,clockCallback=null,ticket=null,session=null,remoteActive=false,remoteTicket=false;
  const requests=[],hooks=new Map(),timers=new Set();
  const clock=()=>{const callback=clockCallback;clockCallback=null;callback?.();return wall;};
  const reply=data=>Response.json({ok:true,data});
  const producer=createNativeLogin({enabled:true,clock,timeoutMs,fetchImpl:async(url,options)=>{
    const leaf=url.split('/').at(-1),route=url.includes('/native-receipt/')?`receipt-${leaf}`:leaf,body=JSON.parse(options.body);
    requests.push({route,body,signal:options.signal});
    if(route==='start'){
      ticket={deviceId:body.deviceId,challenge:body.challenge,expiresAtMs:wall+60000};remoteTicket=true;
    }
    const respond=()=>{
      if(route==='start')return reply({...ticket,confirmation:'123456',state:'pending',
        approvalUrl:`https://aleph-omega.vercel.app/workbench.html?nativeLogin=alekov&device=${ticket.deviceId}&challenge=${ticket.challenge}`});
      if(route==='redeem'){
        assert.ok(body.deviceId===ticket.deviceId&&hash(body.verifier)===ticket.challenge);
        session={...canonical,nativeSessionId:instance,expiresAtMs:wall+60000,proofUntilMs:wall+30000};
        remoteActive=true;return reply({...session,handle});
      }
      if(route==='nonce')return reply({nonce:'fixture-native-login-nonce',expiresAtMs:wall+10000});
      if(route==='current')return reply(session);
      if(route==='receipt-nonce')return reply({nonce:'R'.repeat(43),expiresAtMs:wall+10000});
      if(route==='receipt-issue')return reply({ticket:'nrp1_'+'T'.repeat(43),challengeId:body.challengeId,contextDigest:body.contextDigest,expiresAtMs:wall+10000});
      if(route==='cancel'){
        assert.ok((body.handle===handle||body.deviceId===ticket?.deviceId)&&hash(body.verifier)===ticket?.challenge,
          'Explicit cancellation must retain its exact synthetic target');
        remoteActive=false;remoteTicket=false;return reply({});
      }
      throw Error('Unexpected synthetic route');
    };
    const hook=hooks.get(route);if(hook){hooks.delete(route);return hook({body,signal:options.signal,respond});}
    return respond();
  }});
  const transport=async(kind,{signal})=>{try{return {ok:true,data:await producer[kind]({}, {signal})};}
    catch(error){return {ok:false,error:{code:nativePublicError(error)}};}};
  const ui=createNativeLoginController({transport,clock,setTimer:(fn,ms)=>{const timer={fn,ms};timers.add(timer);return timer;},clearTimer:timer=>timers.delete(timer)});
  t.after(()=>{ui.reset();producer.close();assert.equal(timers.size,0);});
  return {producer,ui,transport,clock,requests,remote:()=>({active:remoteActive,ticket:remoteTicket}),
    on:(route,hook)=>hooks.set(route,hook),onClock:callback=>{clockCallback=callback;},advance:ms=>{wall+=ms;},
    count:route=>requests.filter(item=>item.route===route).length,
    async prepare(kind='session'){await ui.start();assert.equal(ui.state.phase,'awaiting_approval');if(kind==='session'){await ui.redeem();assert.equal(ui.state.phase,'connected');}},
    pause(route,{commit=false}={}){
      const entered=deferred(),release=deferred();
      hooks.set(route,context=>{const response=commit?context.respond():null;entered.resolve(context);return release.promise.then(()=>response??context.respond());});
      return {entered:entered.promise,release};
    },
  };
}

function assertUnknown(f){
  const data=f.producer.status();
  assert.deepEqual(data,{state:'unknown',expiresAtMs:null,approvalUrl:null,confirmation:null});
  assert.equal(validNativeData(data,f.clock())?.state,'unknown');
}
function operationResources(t){
  const timeoutMs=420000,active=new Set(),clears=new Map(),delays=new Map(),set=globalThis.setTimeout,clear=globalThis.clearTimeout;
  t.mock.method(globalThis,'setTimeout',(fn,ms,...args)=>{const timer=set(fn,ms,...args);active.add(timer);clears.set(timer,0);delays.set(timer,ms);return timer;});
  t.mock.method(globalThis,'clearTimeout',timer=>{if(clears.has(timer)){clears.set(timer,clears.get(timer)+1);active.delete(timer);}return clear(timer);});
  t.after(()=>{for(const timer of active)clear(timer);});
  return {timeoutMs,active,clears,delays,assertReleased(){assert.equal(active.size,0);for(const count of clears.values())assert.equal(count,1,'each acquired timer is released exactly once');}};
}
function controlledNativeTimers(t){
  let mono=0;const records=new Map(),active=new Set(),clear=globalThis.clearTimeout;
  t.mock.method(performance,'now',()=>mono);
  t.mock.method(globalThis,'setTimeout',(callback,delay,...args)=>{
    const token=Object.freeze({id:records.size+1});records.set(token,{callback,delay,args,clears:0});active.add(token);return token;
  });
  t.mock.method(globalThis,'clearTimeout',token=>{
    const record=records.get(token);if(record){record.clears++;active.delete(token);}else clear(token);
  });
  return {records,active,setMono:value=>{mono=value;},
    addedSince(before){const added=[...active].filter(token=>!before.has(token));assert.equal(added.length,1);return added[0];},
    fire(token,at){assert.ok(active.has(token));mono=at;const record=records.get(token);record.callback(...record.args);},
    repeat(token){const record=records.get(token);record.callback(...record.args);},
    assertOnly(tokens){assert.deepEqual(active,new Set(tokens));},
    assertReleased(){assert.equal(active.size,0);for(const record of records.values())assert.equal(record.clears,1,'each actual token is released exactly once');},
  };
}
function assertUnconfirmed(f){
  assert.equal(f.ui.state.phase,'unknown');assert.equal(f.ui.state.cancelUnconfirmed,true);
  assert.equal(f.ui.helpInfo().cancelUnconfirmed,true);
  const view=nativeLoginView(f.ui.state,f.clock());
  assert.ok(view.message.includes(NATIVE_CANCEL_UNCONFIRMED_MESSAGE));
  assert.equal(view.canStart,false);assert.equal(view.canRedeem,false);assert.equal(view.canCancel,true);
}
const receiptInput={challengeId:'22222222-2222-4222-8222-222222222222',contextDigest:'a'.repeat(64)};

for(const [kind,stage] of [['session','nonce'],['session','cancel'],['ticket','cancel']]){
  test(`${kind}: failed ${stage} preserves private cancellation ownership through status and explicit retry`,{timeout:4000},async t=>{
    const f=fixture(t);await f.prepare(kind);const gate=f.pause(stage);const cancelling=f.ui.cancel();
    await gate.entered;assertUnknown(f);assert.equal(f.ui.state.cancelUnconfirmed,true);
    const before=f.requests.length;
    await assert.rejects(f.producer.start(),errorIs('BUSY'));await assert.rejects(f.producer.redeem(),errorIs('BUSY'));
    assert.equal(f.requests.length,before);
    gate.release.reject(Error('Synthetic lost acknowledgment'));await cancelling;
    assertUnknown(f);assertUnconfirmed(f);
    await f.ui.check();assertUnknown(f);assertUnconfirmed(f);assert.equal(f.requests.length,before);
    await turn();assert.equal(f.requests.length,before,'No automatic retry may dispatch');
    await assert.rejects(f.producer.current(),errorIs('UNVERIFIED'));
    await assert.rejects(openNativeOperation(f.producer),errorIs('UNVERIFIED'));
    const retried=f.requests.length;await f.ui.cancel();
    assert.equal(f.requests.length-retried,kind==='session'?2:1);
    assert.equal(f.producer.status().state,'cancelled');assert.equal(f.ui.state.phase,'cancelled');
    assert.equal(f.ui.state.cancelUnconfirmed,false);assert.deepEqual(f.remote(),{active:false,ticket:false});
    assert.equal(nativeLoginView(f.ui.state,f.clock()).canStart,true);
    await f.ui.start();assert.equal(f.ui.state.phase,'awaiting_approval');
  });
}

for(const kind of ['session','ticket'])for(const status of [200,202])test(`${kind}: HTTP ${status} cancellation has the supported completion semantics`,async t=>{
  const f=fixture(t);await f.prepare(kind);
  if(status===202)f.on('cancel',()=>Response.json({ok:true,data:{}},{status:202}));
  await f.ui.cancel();
  if(status===200){assert.equal(f.ui.state.phase,'cancelled');assert.equal(f.ui.state.cancelUnconfirmed,false);}
  else{assertUnknown(f);assertUnconfirmed(f);assert.equal(f.ui.state.reason,'NATIVE_HOST_OUTCOME_UNKNOWN');
    await f.ui.cancel();assert.equal(f.ui.state.phase,'cancelled');}
  assert.deepEqual(f.remote(),{active:false,ticket:false});
});

test('a genuinely empty producer can confirm local cancellation without remote calls',async t=>{
  const f=fixture(t);assert.equal((await f.producer.cancel()).state,'cancelled');assert.equal(f.requests.length,0);
  assert.equal((await f.producer.cancel()).state,'cancelled');assert.equal(f.requests.length,0);
});

for(const invalid of ['nonce-type','expiry-type','expiry-past','expiry-fractional'])test(`cancel rejects ${invalid} before nonce dispatch is reused`,async t=>{
  const f=fixture(t);await f.prepare();
  const data={nonce:'fixture-native-login-nonce',expiresAtMs:f.clock()+1000};
  if(invalid==='nonce-type')data.nonce=23;
  if(invalid==='expiry-type')data.expiresAtMs='101000';
  if(invalid==='expiry-past')data.expiresAtMs=f.clock();
  if(invalid==='expiry-fractional')data.expiresAtMs=f.clock()+0.5;
  f.on('nonce',()=>Response.json({ok:true,data}));await f.ui.cancel();
  assertUnknown(f);assertUnconfirmed(f);assert.equal(f.ui.state.reason,'NATIVE_HOST_RESPONSE_INVALID');assert.equal(f.count('cancel'),0);
  await f.ui.cancel();assert.equal(f.ui.state.phase,'cancelled');assert.equal(f.count('cancel'),1);
});

test('pre-aborted cancellation revokes local authority but retains its explicit retry target',async t=>{
  const f=fixture(t);await f.prepare();const signal=AbortSignal.abort();const before=f.requests.length;
  await assert.rejects(f.producer.cancel({}, {signal}),errorIs('CANCELLED'));
  assertUnknown(f);assert.equal(f.requests.length,before);
  await assert.rejects(f.producer.current(),errorIs('UNVERIFIED'));
  await f.producer.cancel();assert.equal(f.count('nonce'),1);assert.equal(f.count('cancel'),1);
});

test('the whole cancel exchange shares one deadline and cannot dispatch after a late nonce',async t=>{
  const f=fixture(t);await f.prepare();
  f.on('nonce',({respond})=>{const response=respond();f.advance(1001);return response;});
  await assert.rejects(f.producer.cancel(),errorIs('TIMEOUT'));assertUnknown(f);assert.equal(f.count('cancel'),0);
  await f.producer.cancel();assert.equal(f.producer.status().state,'cancelled');
});

test('a late cancellation acknowledgment remains unknown until an explicit confirmed retry',async t=>{
  const f=fixture(t);await f.prepare();
  f.on('cancel',({respond})=>{const response=respond();f.advance(1001);return response;});
  await f.ui.cancel();assertUnknown(f);assertUnconfirmed(f);
  assert.deepEqual(f.remote(),{active:false,ticket:false},'A committed remote result can still be unconfirmed locally');
  await f.ui.cancel();assert.equal(f.count('cancel'),2);assert.equal(f.ui.state.phase,'cancelled');
});

test('an expired original session cannot authorize work or turn missing cancellation proof into success',async t=>{
  const f=fixture(t);await f.prepare();f.on('nonce',()=>{throw Error('Synthetic nonce loss');});await f.ui.cancel();
  f.advance(70000);await f.ui.check();assertUnknown(f);assertUnconfirmed(f);
  await assert.rejects(f.producer.start(),errorIs('BUSY'));await assert.rejects(f.producer.current(),errorIs('UNVERIFIED'));
  const before=f.requests.length;await f.ui.cancel();assert.equal(f.requests.length-before,2);assert.equal(f.ui.state.phase,'cancelled');
});

for(const operation of ['start','redeem'])test(`cancel during ${operation} keeps a ticket-only retry target and rejects late completion`,async t=>{
  const f=fixture(t);if(operation==='redeem')await f.prepare('ticket');
  const gate=f.pause(operation,{commit:true});const opening=f.producer[operation]();void opening.catch(()=>{});await gate.entered;
  await f.producer.cancel();assert.equal(f.producer.status().state,'cancelled');
  gate.release.resolve();await assert.rejects(opening);await turn();assert.equal(f.producer.status().state,'cancelled');
  assert.equal(f.count('nonce'),0);assert.equal(f.count('cancel'),1);assert.deepEqual(f.remote(),{active:false,ticket:false});
});

test('unknown-expiry failed-start tickets remain cancellable without allowing a replacement start',async t=>{
  const f=fixture(t);f.on('start',()=>{throw Error('Synthetic lost start response');});await f.ui.start();
  assert.equal(f.ui.state.phase,'unknown');await assert.rejects(f.producer.start(),errorIs('BUSY'));
  await f.ui.cancel();assert.equal(f.ui.state.phase,'cancelled');assert.equal(f.count('cancel'),1);
});

test('overlapping explicit cancels cannot lose their target or let a stale response confirm a later failure',async t=>{
  const f=fixture(t);await f.prepare();const gate=f.pause('cancel');const first=f.producer.cancel();void first.catch(()=>{});await gate.entered;
  f.on('nonce',()=>{throw Error('Synthetic retry failure');});const second=f.producer.cancel();
  await assert.rejects(first);await assert.rejects(second);assertUnknown(f);
  gate.release.resolve();await turn();assertUnknown(f);
  await f.producer.cancel();assert.equal(f.producer.status().state,'cancelled');assert.equal(f.count('nonce'),3);
});

for(const operation of ['current','receipt'])test(`cancel invalidates an in-flight ${operation} and never reuses cancellation-only authority`,async t=>{
  const f=fixture(t);await f.prepare();const cap=await openNativeOperation(f.producer);t.after(()=>closeNativeOperation(cap));
  const gate=f.pause(operation==='current'?'current':'receipt-issue');
  const pending=operation==='current'?f.producer.current():issueNativeReceiptTicket(cap,receiptInput);void pending.catch(()=>{});await gate.entered;
  await f.producer.cancel();await assert.rejects(pending);assert.throws(()=>assertNativeOperation(cap));
  gate.release.resolve();await turn();assert.equal(f.producer.status().state,'cancelled');
  const before=f.requests.length;await assert.rejects(issueNativeReceiptTicket(cap,receiptInput));
  await assert.rejects(openNativeOperation(f.producer));assert.equal(f.requests.length,before);
});

for(const operation of ['cancel','close'])test(`${operation} closes settled operation timers and external abort listeners`,async t=>{
  const f=fixture(t);await f.prepare();const resources=operationResources(t),external=new AbortController(),cap=await openNativeOperation(f.producer,{signal:external.signal,timeoutMs:resources.timeoutMs});
  t.after(()=>closeNativeOperation(cap));assert.equal(resources.active.size,1);assert.equal(getEventListeners(external.signal,'abort').length,1);
  await f.producer[operation]();resources.assertReleased();assert.equal(getEventListeners(external.signal,'abort').length,0);
  assert.throws(()=>assertNativeOperation(cap));
});

for(const mode of ['valid','NaN','throwing'])test(`operation open with ${mode} clock cleans resources when acquisition rejects`,async t=>{
  const resources=operationResources(t),external=new AbortController(),failure=Error('Synthetic clock failure');let fetches=0;
  const producer=createNativeLogin({enabled:true,clock:()=>{if(mode==='throwing')throw failure;return mode==='NaN'?NaN:100000;},
    fetchImpl:async()=>{fetches++;throw Error('Unexpected synthetic fetch');}});
  t.after(()=>{producer.close();external.abort();});
  await assert.rejects(openNativeOperation(producer,{signal:external.signal,timeoutMs:resources.timeoutMs}),mode==='throwing'?error=>error===failure:errorIs('UNVERIFIED'));
  resources.assertReleased();assert.equal(getEventListeners(external.signal,'abort').length,0);assert.equal(fetches,0);
  const cleared=[...resources.clears];producer.close();producer.close();assert.deepEqual([...resources.clears],cleared);
});

test('operation open clock reentrant close cleans partial acquisition without dispatch',async t=>{
  const f=fixture(t);await f.prepare();const resources=operationResources(t),external=new AbortController(),before=f.requests.length;
  t.after(()=>external.abort());f.onClock(()=>f.producer.close());
  await assert.rejects(openNativeOperation(f.producer,{signal:external.signal,timeoutMs:resources.timeoutMs}),errorIs('DISABLED'));
  resources.assertReleased();assert.equal(getEventListeners(external.signal,'abort').length,0);assert.equal(f.requests.length,before);
});

test('operation open clock invalidation retains its captured generation and preserves replacement work',async t=>{
  const f=fixture(t);await f.prepare();const resources=operationResources(t),external=new AbortController(),starts=f.count('start');let replacement;
  t.after(()=>external.abort());f.onClock(()=>{replacement=f.producer.start();void replacement.catch(()=>{});});
  await assert.rejects(openNativeOperation(f.producer,{signal:external.signal,timeoutMs:resources.timeoutMs}),errorIs('CONTEXT_CHANGED'));await replacement;
  assert.equal(f.producer.status().state,'awaiting_approval');assert.equal(f.count('start'),starts+1);assert.equal(f.count('nonce'),0);
  resources.assertReleased();assert.equal(getEventListeners(external.signal,'abort').length,0);
});

test('operation open pre-abort sends no request and releases partial acquisition',async t=>{
  const f=fixture(t);await f.prepare();const resources=operationResources(t),external=new AbortController(),before=f.requests.length;external.abort();
  await assert.rejects(openNativeOperation(f.producer,{signal:external.signal,timeoutMs:resources.timeoutMs}),errorIs('CANCELLED'));
  resources.assertReleased();assert.equal(getEventListeners(external.signal,'abort').length,0);assert.equal(f.requests.length,before);
});

test('operation open success owns its resources until idempotent explicit close',async t=>{
  const f=fixture(t);await f.prepare();const resources=operationResources(t),external=new AbortController();
  t.after(()=>external.abort());const cap=await openNativeOperation(f.producer,{signal:external.signal,timeoutMs:resources.timeoutMs});t.after(()=>closeNativeOperation(cap));
  assertNativeOperation(cap);assert.equal(resources.active.size,1);assert.equal(getEventListeners(external.signal,'abort').length,1);
  const [owned]=resources.active;assert.equal(resources.clears.get(owned),0);
  closeNativeOperation(cap);closeNativeOperation(cap);
  resources.assertReleased();assert.equal(resources.clears.get(owned),1);assert.equal(getEventListeners(external.signal,'abort').length,0);assert.throws(()=>assertNativeOperation(cap),errorIs('UNVERIFIED'));
});

for(const kind of ['operation','request'])for(const elapsed of [36,37,38])test(`${kind} initial clock consumes ${elapsed}ms of its original 37ms budget`,async t=>{
  let mono=9000;t.mock.method(performance,'now',()=>mono);t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(t,{timeoutMs:37});if(kind==='operation')await f.prepare();
  const resources=operationResources(t),external=new AbortController(),before=f.requests.length;t.after(()=>external.abort());
  f.onClock(()=>{mono+=elapsed;f.advance(elapsed);});
  const pending=kind==='operation'?openNativeOperation(f.producer,{signal:external.signal,timeoutMs:37}):f.producer.start({}, {signal:external.signal});
  if(elapsed<37){
    const result=await pending;assert.equal(f.requests.length-before,kind==='operation'?2:1);
    if(kind==='operation'){assertNativeOperation(result);assert.equal(resources.active.size,1);closeNativeOperation(result);}
    else{assert.equal(result.state,'awaiting_approval');assert.deepEqual([...resources.delays.values()],[1],'request timer uses the one remaining millisecond');}
  }else{
    await assert.rejects(pending,errorIs(kind==='operation'?'EXPIRED':'TIMEOUT'));
    assert.equal(f.requests.length,before,'expired initial work must not dispatch a refresh or request');
  }
  resources.assertReleased();assert.equal(getEventListeners(external.signal,'abort').length,0);
});

for(const elapsed of [36,37,38])test(`session proof clock consumes ${elapsed}ms of its original 37ms validity`,async t=>{
  let mono=9000,consumed=false;t.mock.method(performance,'now',()=>mono);t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(t);await f.prepare();const resources=operationResources(t),external=new AbortController();t.after(()=>external.abort());
  f.on('current',async({signal,respond})=>{
    const {data}=await respond().json();
    signal.addEventListener('abort',()=>f.onClock(()=>{consumed=true;mono+=elapsed;}),{once:true});
    return Response.json({ok:true,data:{...data,proofUntilMs:f.clock()+37}});
  });
  const pending=openNativeOperation(f.producer,{signal:external.signal,timeoutMs:1000});
  if(elapsed<37){const cap=await pending;assertNativeOperation(cap);closeNativeOperation(cap);}
  else await assert.rejects(pending,errorIs('EXPIRED'));
  assert.equal(consumed,true);assert.equal(f.count('current'),1);resources.assertReleased();assert.equal(getEventListeners(external.signal,'abort').length,0);
});

for(const kind of ['assert','binding'])for(const mutation of ['producer-close','operation-close','abort','replacement'])test(`operation ${kind} rejects ${mutation} during validation clock`,async t=>{
  const f=fixture(t);await f.prepare();const resources=operationResources(t),external=new AbortController();t.after(()=>external.abort());
  const cap=await openNativeOperation(f.producer,{signal:external.signal,timeoutMs:resources.timeoutMs});let replacement,error,mutations=0;
  f.onClock(()=>{mutations++;if(mutation==='producer-close')f.producer.close();else if(mutation==='operation-close')closeNativeOperation(cap);
    else if(mutation==='abort')external.abort();else{replacement=f.producer.start();void replacement.catch(()=>{});}});
  try{if(kind==='assert')assertNativeOperation(cap);else nativeOperationBinding(cap);}catch(caught){error=caught;}
  if(replacement){await replacement;assert.equal(f.producer.status().state,'awaiting_approval');}
  assert.equal(mutations,1);assert.ok(errorIs(mutation==='abort'?'CANCELLED':'UNVERIFIED')(error),'invalidated operation must not return a successful view');
  closeNativeOperation(cap);resources.assertReleased();assert.equal(getEventListeners(external.signal,'abort').length,0);
});

test('operation validation uses one clock sample for lifetime and proof without a later callback',async t=>{
  const f=fixture(t);await f.prepare();const cap=await openNativeOperation(f.producer);t.after(()=>closeNativeOperation(cap));
  for(const validate of [assertNativeOperation,nativeOperationBinding]){
    let reads=0;const clock=()=>{reads++;f.onClock(clock);};f.onClock(clock);
    const result=validate(cap);f.onClock(null);assert.equal(reads,1);assert.deepEqual(result.canonical??result,canonical);
  }
});

test('operation binding permits expired proof while a fresh assertion rejects it',async t=>{
  const f=fixture(t);await f.prepare();const resources=operationResources(t),external=new AbortController();t.after(()=>external.abort());
  const cap=await openNativeOperation(f.producer,{signal:external.signal,timeoutMs:60000});f.advance(30000);
  assert.throws(()=>assertNativeOperation(cap),errorIs('EXPIRED'));assert.deepEqual(nativeOperationBinding(cap).canonical,canonical);
  closeNativeOperation(cap);resources.assertReleased();assert.equal(getEventListeners(external.signal,'abort').length,0);
});

for(const kind of ['open','refresh','receipt'])for(const elapsed of [99,100])test(`operation ${kind} shares its 100ms ceiling through a ${elapsed}ms nonce`,async t=>{
  let mono=9000;t.mock.method(performance,'now',()=>mono);t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(t);await f.prepare();const resources=operationResources(t),external=new AbortController();t.after(()=>external.abort());
  let cap=kind==='open'?null:await openNativeOperation(f.producer,{signal:external.signal,timeoutMs:100});t.after(()=>closeNativeOperation(cap));
  const before=f.requests.length,route=kind==='receipt'?'receipt-nonce':'nonce';
  f.on(route,({respond})=>{const response=respond();mono+=elapsed;f.advance(elapsed);return response;});
  const pending=kind==='open'?openNativeOperation(f.producer,{signal:external.signal,timeoutMs:100})
    :kind==='refresh'?refreshNativeOperation(cap):issueNativeReceiptTicket(cap,receiptInput);
  if(elapsed<100){const result=await pending;if(kind==='open')cap=result;
    else if(kind==='refresh')assert.deepEqual(result,canonical);else assert.equal(result.ticket,'nrp1_'+'T'.repeat(43));
    assert.deepEqual(f.requests.slice(before).map(r=>r.route),[route,kind==='receipt'?'receipt-issue':'current']);
  }else{await assert.rejects(pending,errorIs('EXPIRED'));assert.deepEqual(f.requests.slice(before).map(r=>r.route),[route]);}
  assert.equal(resources.active.size,cap?1:0,'settled exchange releases request timers before fallback operation close');
  closeNativeOperation(cap);resources.assertReleased();assert.equal(getEventListeners(external.signal,'abort').length,0);
});

for(const kind of ['open','refresh','receipt'])test(`queued operation ${kind} cannot renew its expired ceiling`,async t=>{
  let mono=9000;t.mock.method(performance,'now',()=>mono);t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(t);await f.prepare();const resources=operationResources(t),external=new AbortController();t.after(()=>external.abort());
  const cap=kind==='open'?null:await openNativeOperation(f.producer,{signal:external.signal,timeoutMs:100});t.after(()=>closeNativeOperation(cap));
  const gate=f.pause('current'),blocking=f.producer.current();await gate.entered;const before=f.requests.length;
  const pending=kind==='open'?openNativeOperation(f.producer,{signal:external.signal,timeoutMs:100})
    :kind==='refresh'?refreshNativeOperation(cap):issueNativeReceiptTicket(cap,receiptInput);void pending.catch(()=>{});
  await turn();mono+=100;f.advance(100);gate.release.resolve();await blocking;
  await assert.rejects(pending,errorIs('EXPIRED'));assert.equal(f.requests.length,before,'no queued request may dispatch after expiry');
  assert.equal(resources.active.size,cap?1:0);closeNativeOperation(cap);resources.assertReleased();assert.equal(getEventListeners(external.signal,'abort').length,0);
});

test('receipt nonce cannot outlive its captured proof, while explicit refresh can renew expired proof',async t=>{
  let mono=9000;t.mock.method(performance,'now',()=>mono);t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(t);await f.prepare();const resources=operationResources(t),external=new AbortController();t.after(()=>external.abort());
  f.on('current',async({respond})=>{const {data}=await respond().json();return Response.json({ok:true,data:{...data,proofUntilMs:f.clock()+37}});});
  const cap=await openNativeOperation(f.producer,{signal:external.signal,timeoutMs:1000});t.after(()=>closeNativeOperation(cap));const before=f.requests.length;
  f.on('receipt-nonce',({respond})=>{const response=respond();mono+=37;f.advance(37);return response;});
  await assert.rejects(issueNativeReceiptTicket(cap,receiptInput),errorIs('EXPIRED'));
  assert.deepEqual(f.requests.slice(before).map(r=>r.route),['receipt-nonce']);assert.equal(resources.active.size,1);
  assert.deepEqual(await refreshNativeOperation(cap),canonical);assert.deepEqual(assertNativeOperation(cap),canonical);
  closeNativeOperation(cap);resources.assertReleased();assert.equal(getEventListeners(external.signal,'abort').length,0);
});

for(const kind of ['open','refresh','receipt'])test(`waiting operation ${kind} settles at its own deadline before the queue releases`,async t=>{
  let mono=9000;t.mock.method(performance,'now',()=>mono);t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(t);await f.prepare();const resources=operationResources(t),external=new AbortController();t.after(()=>external.abort());
  const cap=kind==='open'?null:await openNativeOperation(f.producer,{signal:external.signal,timeoutMs:100});t.after(()=>closeNativeOperation(cap));
  const gate=f.pause('current'),blocking=f.producer.current();await gate.entered;const before=f.requests.length;let outcome=null;
  const pending=kind==='open'?openNativeOperation(f.producer,{signal:external.signal,timeoutMs:100})
    :kind==='refresh'?refreshNativeOperation(cap):issueNativeReceiptTicket(cap,receiptInput);
  const observed=pending.then(()=>{outcome={ok:true};},error=>{outcome={code:error.code};});
  await turn();mono+=100;f.advance(100);t.mock.timers.tick(100);await turn();
  const atDeadline={outcome,requests:f.requests.length};
  gate.release.resolve();await blocking;await observed;
  assert.deepEqual(atDeadline.outcome,{code:'NATIVE_HOST_EXPIRED'},'caller settles before unrelated queued work completes');
  assert.equal(atDeadline.requests,before);assert.equal(f.requests.length,before,'expired queue entry never starts later');
  closeNativeOperation(cap);resources.assertReleased();assert.equal(getEventListeners(external.signal,'abort').length,0);
});

for(const cause of ['operation','request','caller'])test(`pending refresh distinguishes ${cause} expiry or cancellation`,async t=>{
  let mono=9000;t.mock.method(performance,'now',()=>mono);t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(t,{timeoutMs:cause==='request'?37:1000});await f.prepare();
  const resources=operationResources(t),external=new AbortController();t.after(()=>external.abort());const gate=f.pause('nonce');let outcome;
  const pending=openNativeOperation(f.producer,{signal:external.signal,timeoutMs:100});
  const observed=pending.then(()=>{outcome={ok:true};},error=>{outcome={code:error.code};});await gate.entered;
  if(cause==='caller')external.abort();else{const elapsed=cause==='request'?37:100;mono+=elapsed;f.advance(elapsed);t.mock.timers.tick(elapsed);}
  await observed;const atCompletion=outcome;gate.release.resolve();await turn();
  assert.deepEqual(atCompletion,{code:'NATIVE_HOST_'+(cause==='operation'?'EXPIRED':cause==='request'?'TIMEOUT':'CANCELLED')});
  assert.equal(f.count('current'),0);resources.assertReleased();assert.equal(getEventListeners(external.signal,'abort').length,0);
});

test('a queued clock throwing undefined retires the entry without dispatch',async t=>{
  const f=fixture(t);await f.prepare();const resources=operationResources(t),external=new AbortController();t.after(()=>external.abort());const before=f.requests.length;
  f.onClock(()=>f.onClock(()=>{throw undefined;}));let rejected=false;
  await openNativeOperation(f.producer,{signal:external.signal}).then(()=>assert.fail('clock failure must reject'),error=>{rejected=true;assert.equal(error,undefined);});
  await turn();assert.equal(rejected,true);assert.equal(f.requests.length,before);resources.assertReleased();assert.equal(getEventListeners(external.signal,'abort').length,0);
});

test('request wall timeout remains TIMEOUT when a clock correction leaves the operation valid',async t=>{
  t.mock.method(performance,'now',()=>0);t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(t);await f.prepare();const resources=operationResources(t),external=new AbortController();t.after(()=>external.abort());
  const cap=await openNativeOperation(f.producer,{signal:external.signal,timeoutMs:100});t.after(()=>closeNativeOperation(cap));const before=f.requests.length;
  f.advance(-10000);f.on('nonce',({respond})=>{f.advance(1000);return respond();});
  await assert.rejects(refreshNativeOperation(cap),errorIs('TIMEOUT'));
  assert.deepEqual(assertNativeOperation(cap),canonical);assert.deepEqual(f.requests.slice(before).map(r=>r.route),['nonce']);
  assert.equal(resources.active.size,1);closeNativeOperation(cap);resources.assertReleased();assert.equal(getEventListeners(external.signal,'abort').length,0);
});

for(const path of ['request','queue'])for(const mode of ['early','equality','normal'])test(`owned deadline timer ${path} ${mode} preserves its absolute proof ceiling`,async t=>{
  const timers=controlledNativeTimers(t),f=fixture(t);await f.prepare();
  f.on('current',async({respond})=>{const {data}=await respond().json();return Response.json({ok:true,data:{...data,proofUntilMs:100060}});});
  const cap=await openNativeOperation(f.producer,{timeoutMs:1000});t.after(()=>closeNativeOperation(cap));
  const [operationTimer]=timers.active;assert.equal(timers.active.size,1);
  const gate=f.pause(path==='queue'?'current':'receipt-nonce');t.after(()=>gate.release.resolve());
  const blocking=path==='queue'?f.producer.current():null;void blocking?.catch(()=>{});if(blocking)await gate.entered;
  timers.setMono(0.25);const before=new Set(timers.active),requestCount=f.requests.length;let outcome=null;
  const observed=issueNativeReceiptTicket(cap,receiptInput).then(value=>{outcome={ok:true};return value;},error=>{outcome={code:error?.code};});
  if(path==='request')await gate.entered;else await turn();
  const owned=timers.addedSince(before);
  if(mode!=='normal'){
    timers.fire(owned,mode==='early'?59.25:60);await turn();
    assert.equal(timers.records.get(owned).clears,1,'release the fired token before checking fallback cleanup');
    if(mode==='early'){
      assert.equal(outcome,null,'an early wake must not declare expiry');assertNativeOperation(cap);
      const replacement=timers.addedSince(before);assert.notEqual(replacement,owned);
      assert.equal(timers.records.get(replacement).delay,1,'ceil the positive sub-millisecond remainder');
      const retained=new Set(timers.active);timers.repeat(owned);assert.deepEqual(timers.active,retained);
      assert.equal(timers.records.get(owned).clears,1,'a stale callback cannot clear or replace another token');
    }else{
      assert.deepEqual(outcome,{code:'NATIVE_HOST_EXPIRED'});assert.throws(()=>assertNativeOperation(cap),errorIs('EXPIRED'));
      timers.assertOnly([...before]);
    }
  }
  if(mode!=='equality')timers.setMono(59.5);
  gate.release.resolve();if(blocking)await blocking;const result=await observed;await turn();
  if(mode==='equality')assert.deepEqual(f.requests.slice(requestCount).map(item=>item.route),path==='request'?['receipt-nonce']:[]);
  else{assert.equal(result.ticket,'nrp1_'+'T'.repeat(43));assert.deepEqual(f.requests.slice(requestCount).map(item=>item.route),['receipt-nonce','receipt-issue']);}
  timers.assertOnly([operationTimer]);closeNativeOperation(cap);timers.assertReleased();
});

for(const mode of ['early','equality','normal'])test(`owned deadline timer operation ${mode} retains exactly one lifetime timer`,async t=>{
  const timers=controlledNativeTimers(t),f=fixture(t);await f.prepare();
  const cap=await openNativeOperation(f.producer,{timeoutMs:60});t.after(()=>closeNativeOperation(cap));
  const [owned]=timers.active;assert.equal(timers.active.size,1);const {signal}=nativeOperationBinding(cap);let aborts=0;
  signal.addEventListener('abort',()=>{aborts++;},{once:true});
  if(mode!=='normal'){
    timers.fire(owned,mode==='early'?59.25:60);await turn();
    assert.equal(timers.records.get(owned).clears,1,'release the fired operation token before explicit close');
    if(mode==='early'){
      assert.equal(aborts,0);assertNativeOperation(cap);const [replacement]=timers.active;
      assert.equal(timers.active.size,1);assert.notEqual(replacement,owned);assert.equal(timers.records.get(replacement).delay,1);
      timers.repeat(owned);assert.equal(aborts,0);timers.assertOnly([replacement]);assert.equal(timers.records.get(owned).clears,1);
    }else{assert.equal(aborts,1);assert.throws(()=>assertNativeOperation(cap),errorIs('EXPIRED'));timers.assertReleased();timers.repeat(owned);assert.equal(aborts,1);}
  }else{timers.setMono(59.5);assertNativeOperation(cap);assert.equal(aborts,0);}
  closeNativeOperation(cap);timers.assertReleased();assert.equal(aborts,1);
});

for(const path of ['request','queue'])test(`owned deadline timer ${path} cannot rearm after cancellation inside its clock sample`,async t=>{
  const timers=controlledNativeTimers(t),f=fixture(t);await f.prepare();const external=new AbortController();
  const cap=await openNativeOperation(f.producer,{timeoutMs:1000,signal:external.signal});t.after(()=>closeNativeOperation(cap));
  const [operationTimer]=timers.active,gate=f.pause(path==='queue'?'current':'receipt-nonce');t.after(()=>gate.release.resolve());
  const blocking=path==='queue'?f.producer.current():null;void blocking?.catch(()=>{});if(blocking)await gate.entered;
  const before=new Set(timers.active),requestCount=f.requests.length;let outcome;
  const observed=issueNativeReceiptTicket(cap,receiptInput).then(()=>{outcome={ok:true};},error=>{outcome={code:error?.code};});
  if(path==='request')await gate.entered;else await turn();
  const owned=timers.addedSince(before),acquired=timers.records.size;f.onClock(()=>external.abort());
  timers.fire(owned,1);await observed;
  assert.deepEqual(outcome,{code:'NATIVE_HOST_CANCELLED'});assert.equal(timers.records.size,acquired,'reentrant cancellation cannot allocate a replacement timer');
  assert.equal(timers.records.get(owned).clears,1);timers.assertOnly([...before]);
  gate.release.resolve();if(blocking)await blocking;await turn();
  assert.deepEqual(f.requests.slice(requestCount).map(item=>item.route),path==='request'?['receipt-nonce']:[]);
  timers.assertOnly([operationTimer]);closeNativeOperation(cap);timers.assertReleased();assert.equal(getEventListeners(external.signal,'abort').length,0);
});

for(const cause of ['producer-close','generation-change'])for(const via of ['clock','direct'])test(`request invalidation cause ${cause} through ${via} precedes a still-live deadline`,async t=>{
  const timers=controlledNativeTimers(t),f=fixture(t);await f.prepare();
  f.on('current',async({respond})=>{const {data}=await respond().json();return Response.json({ok:true,data:{...data,proofUntilMs:100060}});});
  const external=new AbortController(),cap=await openNativeOperation(f.producer,{timeoutMs:1000,signal:external.signal});t.after(()=>closeNativeOperation(cap));
  const [operationTimer]=timers.active;timers.setMono(0.25);const before=new Set(timers.active),requestCount=f.requests.length,gate=f.pause('receipt-nonce');t.after(()=>gate.release.resolve());
  let outcome,replacement;
  const observed=issueNativeReceiptTicket(cap,receiptInput).then(()=>{outcome={ok:true};},error=>{outcome={code:error?.code};});
  await gate.entered;const requestTimer=timers.addedSince(before);
  const invalidate=()=>{if(cause==='producer-close')f.producer.close();else{replacement=f.producer.start();void replacement.catch(()=>{});}};
  if(via==='clock'){f.onClock(invalidate);timers.fire(requestTimer,17.125);}else{timers.setMono(17.125);invalidate();}
  await observed;if(replacement){assert.equal((await replacement).state,'awaiting_approval');assert.equal(f.producer.status().state,'awaiting_approval');}
  else assert.throws(()=>f.producer.status(),errorIs('DISABLED'));
  timers.assertReleased();assert.equal(getEventListeners(external.signal,'abort').length,0);
  const acquired=timers.records.size;timers.repeat(requestTimer);timers.repeat(operationTimer);assert.equal(timers.records.size,acquired);timers.assertReleased();
  gate.release.resolve();await turn();
  assert.deepEqual(f.requests.slice(requestCount).map(item=>item.route),cause==='producer-close'?['receipt-nonce']:['receipt-nonce','start']);
  t.diagnostic(JSON.stringify({cause,via,monotonicMs:17.125,proofDeadlineMs:60,operationDeadlineMs:1000,outcome,activeTimers:timers.active.size}));
  assert.deepEqual(outcome,{code:cause==='producer-close'?'NATIVE_HOST_DISABLED':'NATIVE_HOST_CONTEXT_CHANGED'});
});

test('request timer preserves a falsy clock error when its owner remains active',async t=>{
  const timers=controlledNativeTimers(t),f=fixture(t);await f.prepare();
  const cap=await openNativeOperation(f.producer,{timeoutMs:1000});t.after(()=>closeNativeOperation(cap));
  const [operationTimer]=timers.active,before=new Set(timers.active),requestCount=f.requests.length,gate=f.pause('receipt-nonce');t.after(()=>gate.release.resolve());
  let rejected=false,rejection;
  const observed=issueNativeReceiptTicket(cap,receiptInput).then(()=>assert.fail('clock failure must reject'),error=>{rejected=true;rejection=error;});
  await gate.entered;const requestTimer=timers.addedSince(before),acquired=timers.records.size;f.onClock(()=>{throw undefined;});
  timers.fire(requestTimer,17.125);await observed;
  assert.equal(rejected,true);assert.equal(rejection,undefined);assertNativeOperation(cap);
  assert.equal(timers.records.size,acquired);assert.equal(timers.records.get(requestTimer).clears,1);timers.assertOnly([operationTimer]);
  gate.release.resolve();await turn();assert.deepEqual(f.requests.slice(requestCount).map(item=>item.route),['receipt-nonce']);
  closeNativeOperation(cap);timers.assertReleased();
});

test('close during cancellation drops ownership and blocks every late continuation and subsequent call',async t=>{
  const f=fixture(t);await f.prepare();const gate=f.pause('cancel');const pending=f.producer.cancel();void pending.catch(()=>{});await gate.entered;
  f.producer.close();await assert.rejects(pending);const before=f.requests.length;gate.release.resolve();await turn();
  assert.throws(()=>f.producer.status(),errorIs('DISABLED'));
  for(const method of ['start','redeem','current','cancel'])await assert.rejects(f.producer[method](),errorIs('DISABLED'));
  await assert.rejects(openNativeOperation(f.producer),errorIs('DISABLED'));assert.equal(f.requests.length,before);
});

test('a reentrant abort callback cannot make an older cancel adopt the newer cancel generation',async t=>{
  const f=fixture(t);await f.prepare();const gate=f.pause('current');const reading=f.producer.current();void reading.catch(()=>{});
  const context=await gate.entered;let inner;
  context.signal.addEventListener('abort',()=>{inner=f.producer.cancel();void inner.catch(()=>{});},{once:true});
  const outer=f.producer.cancel();await assert.rejects(outer,errorIs('CONTEXT_CHANGED'));await inner;await assert.rejects(reading);
  gate.release.resolve();await turn();assert.equal(f.producer.status().state,'cancelled');assert.equal(f.count('cancel'),1);
});

test('a reentrant close during invalidation prevents replacement start dispatch',async t=>{
  const f=fixture(t);await f.prepare();const gate=f.pause('current');const reading=f.producer.current();void reading.catch(()=>{});
  const context=await gate.entered;context.signal.addEventListener('abort',()=>f.producer.close(),{once:true});
  const before=f.count('start');await assert.rejects(f.producer.start(),errorIs('DISABLED'));await assert.rejects(reading);
  gate.release.resolve();assert.equal(f.count('start'),before);assert.throws(()=>f.producer.status(),errorIs('DISABLED'));
});

test('cancel entry clock reentrancy cannot cancel a replacement flow it did not own at entry',async t=>{
  const f=fixture(t);await f.prepare();let replacement;
  f.onClock(()=>{replacement=f.producer.start();void replacement.catch(()=>{});});
  await assert.rejects(f.producer.cancel(),errorIs('CONTEXT_CHANGED'));await replacement;
  assert.equal(f.producer.status().state,'awaiting_approval');assert.equal(f.count('cancel'),0);assert.equal(f.count('nonce'),0);
});

for(const resetDuring of [false,true])test(`native reset ${resetDuring?'during':'after failed'} cancellation preserves uncertainty through another unknown check`,async t=>{
  const f=fixture(t);await f.prepare();const gate=f.pause('cancel');const pending=f.ui.cancel();await gate.entered;
  if(resetDuring){f.ui.reset();await pending;gate.release.resolve();}
  else{gate.release.reject(Error('Synthetic cancel loss'));await pending;f.ui.reset();}
  assertUnconfirmed(f);await f.ui.check();assertUnconfirmed(f);assertUnknown(f);
  await f.ui.cancel();assert.equal(f.ui.state.phase,'cancelled');assert.equal(f.ui.state.cancelUnconfirmed,false);
});

for(const observed of ['unknown','starting','malformed','failure','cancelled'])test(`native ${observed} observation has the correct cancellation-warning semantics`,async t=>{
  const f=fixture(t);await f.prepare();f.on('cancel',()=>{throw Error('Synthetic cancel loss');});await f.ui.cancel();assertUnconfirmed(f);
  let outcome;
  const ui=createNativeLoginController({transport:async(kind,options)=>kind==='status'&&outcome?outcome:f.transport(kind,options),clock:f.clock,
    setTimer:()=>1,clearTimer:()=>{}});t.after(()=>ui.reset());
  await ui.check();await ui.cancel(); // The producer confirms this explicit retry.
  await ui.start();await ui.redeem();f.on('cancel',()=>{throw Error('Synthetic second cancellation loss');});await ui.cancel();
  assert.equal(ui.state.cancelUnconfirmed,true);
  if(observed==='failure')outcome={ok:false,error:{code:'NATIVE_HOST_UNVERIFIED'}};
  else if(observed==='malformed')outcome={ok:true,data:{state:'unknown'}};
  else outcome={ok:true,data:{state:observed,expiresAtMs:null,approvalUrl:null,confirmation:null}};
  await ui.check();assert.equal(ui.state.cancelUnconfirmed,observed!=='cancelled');
  assert.equal(ui.helpInfo().cancelUnconfirmed,observed!=='cancelled');
  if(observed!=='cancelled')assert.ok(nativeLoginView(ui.state,f.clock()).message.includes(NATIVE_CANCEL_UNCONFIRMED_MESSAGE));
});
