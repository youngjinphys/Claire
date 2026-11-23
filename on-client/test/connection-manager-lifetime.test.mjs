import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createConnectionManager} from '../src/connection/manager.mjs';

const turn=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const realSetTimeout=setTimeout,realClearTimeout=clearTimeout;
async function reachBeforeCompletion(pending,reached){
  let timer;
  try{await Promise.race([reached.promise,pending.then(()=>{throw Error('operation finished before the fixture gate');}),
    new Promise((_,reject)=>{timer=realSetTimeout(()=>reject(Error('fixture gate was not reached')),1500);})]);}
  finally{realClearTimeout(timer);}
}
const context={subjectId:'student',alephUserId:'aleph-user',siteId:'site',identityVersion:1,projectId:'review-project'};
const scope={schema:'aleph.on.ai-identity.v1',sourceSubjectId:'source',canonicalStudentId:'student',alephUserId:'aleph-user',siteId:'site',identityVersion:1,projectId:'review-project',sessionId:'session'};
function startedResponse(options,at=Date.now()){
  const input=JSON.parse(options.body);
  return Response.json({schema:'alekov.app-connect.start.v2',deviceId:input.deviceId,challenge:input.challenge,contextDigest:input.contextDigest,
    expiresAt:new Date(at+60000).toISOString(),approvalUrl:`https://aleph-omega.vercel.app/workbench.html?appConnect=alekov&appDevice=${input.deviceId}&appChallenge=${input.challenge}`,state:'pending'},{status:201});
}
function generic(t,{readServerScope=async()=>scope,fetchImpl=async(_,options)=>startedResponse(options),...options}={}){
  const manager=createConnectionManager({enabled:true,readServerScope,vault:{persistCredential:async()=>null},fetchImpl,...options});
  t.after(()=>manager.close());return manager;
}

// Execute the production manager and real connector with only its Windows-only
// native-context dependency stubbed. These are lifetime tests, not registry/ACL evidence.
let fixtureId=0;
async function native(t,{fetchImpl=async(_,options)=>startedResponse(options),...options}={}){
  const host={},cap={},closed=[];let open=async()=>cap,read=async()=>context,persist=async()=>null,assertCurrent=()=>context,assertContinuity=()=>context;
  const stubs={isNativeHostContext:value=>value===host,openNativeHostOperation:(...args)=>open(...args),readNativeHostOperation:(...args)=>read(...args),
    assertNativeHostOperation:(...args)=>assertCurrent(...args),assertNativeHostContinuity:(...args)=>assertContinuity(...args),createNativeOperationVault:()=>({persistCredential:(...args)=>persist(...args)}),closeNativeHostOperation:value=>{if(value)closed.push(value);}};
  const key=`__nativeManagerLifetimeFixture${++fixtureId}`;globalThis[key]=stubs;
  let source=await readFile(new URL('../src/connection/manager.mjs',import.meta.url),'utf8');
  source=source.replace("from '../ai/connection.mjs'",`from '${new URL('../src/ai/connection.mjs',import.meta.url).href}'`)
    .replace("from './native-login.mjs'",`from '${new URL('../src/connection/native-login.mjs',import.meta.url).href}'`)
    .replace("from '../../public/deadline-timer.mjs'",`from '${new URL('../public/deadline-timer.mjs',import.meta.url).href}'`)
    .replace(/import \{([^}]+)\} from '\.\/native-context\.mjs';/,`const {$1}=globalThis.${key};`);
  let create;try{({createConnectionManager:create}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64')));}finally{delete globalThis[key];}
  const manager=create({enabled:true,nativeHost:host,fetchImpl,...options});t.after(()=>manager.close());
  return {manager,cap,closed,setOpen:value=>open=value,setRead:value=>read=value,setPersist:value=>persist=value,setAssert:value=>assertCurrent=value,setContinuity:value=>assertContinuity=value};
}

// Timers deliberately stay queued while independent promise continuations run.
// Capture the actual public reply construction, not just the time when the test
// eventually receives its promise (a timely acceptance may be observed later).
function timing(t){
  let mono=0;const published=new WeakMap(),freeze=Object.freeze;
  t.mock.method(performance,'now',()=>mono);
  t.mock.timers.enable({apis:['setTimeout']});
  t.mock.method(Object,'freeze',value=>{if(value&&typeof value.status==='number'&&value.body)published.set(value,mono);return freeze(value);});
  const after=(depth,work)=>queueMicrotask(()=>{if(depth>1)after(depth-1,work);else work();});
  return {get now(){return mono;},set(value){mono=value;},after,publication:result=>{const at=published.get(result);assert.ok(Number.isFinite(at),'the actual public reply must be observed');return at;}};
}
function controlledManagerTimers(t,{firstStartCost=0}={}){
  let mono=0;const records=[],active=new Set(),clear=globalThis.clearTimeout;
  t.mock.method(performance,'now',()=>mono);
  t.mock.method(globalThis,'setTimeout',(callback,delay,...args)=>{
    const token={callback,delay,args,createdAt:mono,clears:0};records.push(token);active.add(token);
    if(records.length===1)mono+=firstStartCost;return token;
  });
  t.mock.method(globalThis,'clearTimeout',token=>{if(records.includes(token)){token.clears++;active.delete(token);}else clear(token);});
  return {records,active,get now(){return mono;},set(value){mono=value;},
    fire(token,at){assert.ok(active.has(token));mono=at;token.callback(...token.args);},
    repeat(token){token.callback(...token.args);},
    addedSince(before){const added=[...active].filter(token=>!before.has(token));assert.equal(added.length,1);return added[0];},
    assertReleased(){assert.equal(active.size,0);for(const token of records)assert.equal(token.clears,1,'release each actual timer token once');},
  };
}
const sha=value=>createHash('sha256').update(value).digest('hex');
function persisted(input){return {connectionId:input.connectionId,credentialFingerprint:sha(input.credential.token),
  contextFingerprint:sha(JSON.stringify(Object.fromEntries(Object.entries(input.expectedContext).sort(([a],[b])=>a.localeCompare(b))))),persisted:true};}
function credentialResponse(){return Response.json({schema:'alekov.app-connect.credential.v1',appId:'aleph-on',audience:'on-client',...context,
  grantId:'fixture-grant',grantVersion:1,credentialId:'fixture-credential',policyVersion:'fixture-policy',accessPolicyId:'fixture-access',
  baseUrl:'https://ai-classroom-gateway-production.up.railway.app/api/apps/aleph-on/v1',token:'sk-on-'+'X'.repeat(43),expiresAt:new Date(Date.now()+60000).toISOString()});}

async function capacityFixture(t,kind,{fetchImpl,...options}={}){
  const calls={starts:0,redeems:0,reads:0,opens:0,writes:0},opened=[],wall=options.clock??Date.now;
  const transport=async(url,call)=>{
    if(url.endsWith('/start'))calls.starts++;else calls.redeems++;
    return fetchImpl?fetchImpl(url,call):url.endsWith('/start')?startedResponse(call,wall()):credentialResponse();
  };
  const read=async()=>{calls.reads++;return kind==='native'?context:scope;},save=async input=>{calls.writes++;return persisted(input);};
  if(kind==='generic')return {manager:generic(t,{...options,fetchImpl:transport,readServerScope:read,vault:{persistCredential:save}}),calls};
  const f=await native(t,{...options,fetchImpl:transport});
  f.setOpen(async()=>{calls.opens++;const cap={};opened.push(cap);return cap;});
  f.setRead(read);f.setPersist(save);f.setAssert((_,cap)=>{if(f.closed.includes(cap))throw Error('fixture operation closed');return context;});
  return {...f,calls,opened};
}

test('generic manager close aborts a pending identity lookup and forbids later starts', {timeout:3000},async t=>{
  const gate=deferred(),reached=deferred();let fetches=0;
  const manager=generic(t,{readServerScope:async()=>{reached.resolve();await gate.promise;return scope;},fetchImpl:async()=>{fetches++;return Response.json({});}});
  const pending=manager.start({});await reached.promise;manager.close();
  assert.equal((await pending).status,504);gate.resolve();await turn();
  assert.equal(fetches,0);assert.equal(manager.available,false);assert.equal((await manager.start({})).status,503);
});
test('generic manager checks the monotonic deadline after a synchronous identity delay',async t=>{
  let fetches=0;
  const manager=generic(t,{startTimeoutMs:5,readServerScope:async()=>{const until=performance.now()+20;while(performance.now()<until){}return scope;},
    fetchImpl:async()=>{fetches++;return Response.json({});}});
  assert.equal((await manager.start({})).status,504);assert.equal(fetches,0);
});
for(const kind of ['generic','native'])test(`${kind} manager closes an in-flight begin without registering its late response`, {timeout:3000},async t=>{
  const gate=deferred(),reached=deferred();let fetches=0,cancels=0;
  const options={fetchImpl:async()=>{fetches++;reached.resolve();return gate.promise;}};
  const manager=kind==='generic'?generic(t,options):(await native(t,options)).manager;
  const pending=manager.start({});await reached.promise;manager.close();
  assert.ok([503,504].includes((await pending).status));
  gate.resolve(new Response(new ReadableStream({cancel(){cancels++;}}),{headers:{'content-type':'application/json'}}));await turn();
  assert.equal(fetches,1);assert.equal(cancels,1);assert.equal(manager.available,false);assert.equal((await manager.start({})).status,503);
});
test('native manager closes a late capability opened after shutdown before any connector request', {timeout:3000},async t=>{
  const gate=deferred(),reached=deferred();let fetches=0;
  const f=await native(t,{fetchImpl:async()=>{fetches++;return Response.json({});}});
  f.setOpen(async()=>{reached.resolve();return gate.promise;});
  const pending=f.manager.start({});await reached.promise;f.manager.close();
  assert.equal((await pending).status,503);gate.resolve(f.cap);await turn();
  assert.deepEqual(f.closed,[f.cap]);assert.equal(fetches,0);
});
test('native start retains capability ownership across the acquisition promise boundary',async t=>{
  for(const boundary of ['timely','abort','deadline'])await t.test(boundary,async t=>{
    const time=timing(t),owner=new AbortController();let fetches=0,reads=0,requestSignal;
    const f=await native(t,{maxFlows:1,startTimeoutMs:10,fetchImpl:async(_,call)=>{fetches++;return startedResponse(call);}});
    f.setRead(async()=>{reads++;return context;});
    f.setOpen(async(_,call)=>{
      requestSignal=call.signal;
      // Run after the supplier resumes with the capability, before the
      // surrounding within/stage promises can publish it to start().
      if(boundary!=='timely')time.after(2,()=>boundary==='abort'?owner.abort():time.set(10));
      return f.cap;
    });
    const result=await f.manager.start({},{signal:owner.signal});await turn();
    if(boundary==='timely'){
      assert.equal(result.status,201);assert.equal(fetches,1);assert.ok(reads>0);
      assert.equal(f.closed.includes(f.cap),false,'a timely live flow owns its capability');
      f.manager.close();f.manager.close();
      assert.equal(f.closed.filter(cap=>cap===f.cap).length,1);
      return;
    }
    assert.equal(result.status,504);assert.equal(result.body.error.code,'ALEKOV_CONNECT_DEADLINE');
    assert.equal(fetches,0);assert.equal(reads,0);assert.equal(requestSignal.aborted,true);
    assert.equal(f.closed.filter(cap=>cap===f.cap).length,1,'discarding an acquired result must still close its capability');
    const replacement={};f.setOpen(async()=>replacement);
    assert.equal((await f.manager.start({})).status,201,'failed acquisition must return its capacity reservation');
    assert.equal(fetches,1);f.manager.close();f.manager.close();
    assert.equal(f.closed.filter(cap=>cap===f.cap).length,1);
    assert.equal(f.closed.filter(cap=>cap===replacement).length,1);
  });
});
test('native finish rejects a pre-aborted request before redeeming or changing the flow',async t=>{
  let redeems=0;
  const {manager}=await native(t,{fetchImpl:async(url,options)=>{if(url.endsWith('/start'))return startedResponse(options);redeems++;return Response.json({}, {status:503});}});
  const started=await manager.start({});assert.equal(started.status,201);
  const input={connectionId:started.body.data.connectionId},controller=new AbortController();controller.abort();
  assert.equal((await manager.finish(input,{signal:controller.signal})).status,504);await turn();assert.equal(redeems,0);
  assert.equal((await manager.status(input)).body.data.state,'awaiting_approval');
});
test('native finish handles cancellation during identity lookup without starting an independent job', {timeout:3000},async t=>{
  let redeems=0;const f=await native(t,{fetchImpl:async(url,options)=>{if(url.endsWith('/start'))return startedResponse(options);redeems++;return Response.json({}, {status:503});}});
  const started=await f.manager.start({});assert.equal(started.status,201);
  const gate=deferred(),reached=deferred();f.setRead(async()=>{reached.resolve();return gate.promise;});
  const controller=new AbortController(),pending=f.manager.finish({connectionId:started.body.data.connectionId},{signal:controller.signal});
  await reached.promise;controller.abort();assert.equal((await pending).status,504);gate.resolve(context);await turn();assert.equal(redeems,0);
});
test('native failed identity lookup is a failed lookup, not an ignored null sentinel',async t=>{
  let redeems=0;const f=await native(t,{fetchImpl:async(url,options)=>{if(url.endsWith('/start'))return startedResponse(options);redeems++;return Response.json({}, {status:503});}});
  const started=await f.manager.start({});assert.equal(started.status,201);f.setRead(async()=>{throw Error('source unavailable');});
  const input={connectionId:started.body.data.connectionId},result=await f.manager.finish(input);
  assert.equal(result.status,409);assert.equal(result.body.error.code,'ALEKOV_CONNECT_CONTEXT_CHANGED');assert.equal(redeems,0);
  assert.equal((await f.manager.status(input)).body.data.state,'unknown');
});
test('native finish treats the identity lookup timeout sentinel as a deadline, without redeeming',async t=>{
  const time=timing(t);
  let redeems=0;const f=await native(t,{fetchImpl:async(url,options)=>{if(url.endsWith('/start'))return startedResponse(options);redeems++;return Response.json({}, {status:503});}});
  try{
    const started=await f.manager.start({});assert.equal(started.status,201);
    const gate=deferred(),reached=deferred();f.setRead(async()=>{reached.resolve();return gate.promise;});
    const pending=f.manager.finish({connectionId:started.body.data.connectionId});await reached.promise;time.set(5000);t.mock.timers.tick(5000);
    const result=await pending;assert.equal(result.status,504);assert.equal(result.body.error.code,'ALEKOV_CONNECT_DEADLINE');
    gate.resolve(context);await turn();assert.equal(redeems,0);
  }finally{f.manager.close();t.mock.timers.reset();}
});
for(const kind of ['generic','native'])test(`${kind} accepted background work has its own lifetime after the HTTP request ends`,{timeout:3000},async t=>{
  const gate=deferred(),reached=deferred();let requestSignal;
  const options={fetchImpl:async(url,options)=>{if(url.endsWith('/start'))return startedResponse(options);requestSignal=options.signal;reached.resolve();return gate.promise;}};
  const manager=kind==='generic'?generic(t,options):(await native(t,options)).manager;
  const started=await manager.start({});assert.equal(started.status,201);
  const controller=new AbortController(),result=await manager.finish({connectionId:started.body.data.connectionId},{signal:controller.signal});
  assert.equal(result.status,202);controller.abort();await reached.promise;assert.equal(requestSignal.aborted,false);
  manager.close();assert.equal(requestSignal.aborted,true);gate.resolve(Response.json({}, {status:503}));await turn();
});

test('generic start keeps its deadline through the final scope await and public registration',async t=>{
  for(const outcome of ['valid','failed'])for(let depth=1;depth<=10;depth++)await t.test(`${outcome}, microtask depth ${depth}`,async t=>{
    const time=timing(t);let posted=false,afterPostReads=0,connectionId;
    const manager=generic(t,{startTimeoutMs:10,readServerScope:async()=>{
      // The connector rechecks after its response, then the manager independently
      // verifies scope before it registers the public flow.
      if(posted&&++afterPostReads===2){time.after(depth,()=>time.set(11));if(outcome==='failed')throw Error('fixture source unavailable');}
      return scope;
    },fetchImpl:async(_,options)=>{posted=true;connectionId=JSON.parse(options.body).deviceId;return startedResponse(options);}});
    const result=await manager.start({}),at=time.publication(result);
    if(at>=10)assert.equal(result.status,504,'an expired observation must not publish a successful or failed start');
    else assert.equal(result.status,outcome==='valid'?201:409);
    await turn();
    const observed=await manager.status({connectionId});
    assert.equal(observed.status,result.status===201?200:404,'only a timely successful start may register a flow');
  });
});

for(const kind of ['generic','native'])for(const method of ['finish','cancel','status'])test(`${kind} ${method} carries lookup deadlines through positive and failed final-await observations`,async t=>{
  for(const outcome of ['valid','failed'])for(let depth=1;depth<=10;depth++)await t.test(`${outcome}, microtask depth ${depth}`,async t=>{
    const time=timing(t),budget=kind==='generic'?10:5000;let inject=false,lookupReads=0,redeems=0;
    const read=async()=>{if(inject&&++lookupReads===1){time.after(depth,()=>time.set(budget+1));if(outcome==='failed')throw Error('fixture source unavailable');}return kind==='generic'?scope:context;};
    const options={fetchImpl:async(url,options)=>{if(url.endsWith('/start'))return startedResponse(options);redeems++;return new Promise(()=>{});}};
    const f=kind==='native'?await native(t,options):null;
    const manager=f?.manager??generic(t,{...options,scopeTimeoutMs:budget,readServerScope:read});if(f)f.setRead(read);
    const started=await manager.start({});assert.equal(started.status,201);
    const input={connectionId:started.body.data.connectionId};inject=true;
    const result=await manager[method](input),at=time.publication(result);inject=false;
    await turn();
    if(at>=budget)assert.equal(result.status,504,'the public continuation must reject expired positive and negative observations');
    else assert.equal(result.status,outcome==='failed'?409:method==='finish'?202:200);
    if(result.status===504){
      assert.equal(redeems,0,'expired lookup must not redeem');
      assert.equal((await manager.status(input)).body.data.state,'awaiting_approval','expired lookup must leave the flow unchanged');
    }else if(outcome==='failed')assert.equal(redeems,0);
  });
});

for(const kind of ['generic','native'])test(`${kind} cancel accounts for configured clock work before the final mutation`,async t=>{
  const time=timing(t),budget=kind==='generic'?10:5000;let armed=false,calls=0;
  const options={clock:()=>{if(armed&&++calls===2)time.set(budget+1);return Date.now();}};
  const manager=kind==='generic'?generic(t,{...options,scopeTimeoutMs:budget}):(await native(t,options)).manager;
  const started=await manager.start({});assert.equal(started.status,201);armed=true;
  const result=await manager.cancel({connectionId:started.body.data.connectionId});armed=false;
  assert.ok(time.publication(result)<budget||result.status===504,'configured clock work must not allow a late cancellation');
});

test('native start rechecks its own deadline after every native assertion, including the final assertion',async t=>{
  let assertions=0;
  await t.test('count the real start assertions with a timely native dependency',async t=>{
    timing(t);const f=await native(t,{startTimeoutMs:10});f.setAssert(()=>{assertions++;return context;});
    assert.equal((await f.manager.start({})).status,201);
  });
  assert.ok(assertions>0);
  for(let index=1;index<=assertions;index++)await t.test(`assertion ${index} consumes the start budget`,async t=>{
    const time=timing(t);let calls=0,connectionId;
    const f=await native(t,{startTimeoutMs:10,fetchImpl:async(_,options)=>{connectionId=JSON.parse(options.body).deviceId;return startedResponse(options);}});
    f.setAssert(()=>{if(++calls===index)time.set(11);return context;});
    const result=await f.manager.start({});assert.equal(result.status,504);
    if(connectionId)assert.equal((await f.manager.status({connectionId})).status,404,'an expired start must not publish its flow');
  });
});

for(const kind of ['generic','native'])test(`${kind} background final verification shares the original job deadline for success and failure`,async t=>{
  for(const outcome of ['valid','failed'])for(let depth=1;depth<=12;depth++)await t.test(`${outcome}, microtask depth ${depth}`,async t=>{
    const time=timing(t);let stored=0,afterStoreReads=0,finalRead=false;const settlements=[];
    const read=async()=>{
      // The SDK performs its own post-save check; the next check is the manager's
      // final verification and must fit within the already accepted job budget.
      if(stored&&++afterStoreReads===2){finalRead=true;time.after(depth,()=>time.set(11));if(outcome==='failed')throw Error('fixture final source unavailable');}
      return kind==='generic'?scope:context;
    };
    const save=async input=>{stored++;return persisted(input);};
    const options={finishTimeoutMs:10,clock:()=>{if(finalRead)settlements.push(time.now);return Date.now();},
      fetchImpl:async(url,options)=>url.endsWith('/start')?startedResponse(options):credentialResponse()};
    const f=kind==='native'?await native(t,options):null;
    const manager=f?.manager??generic(t,{...options,scopeTimeoutMs:100,readServerScope:read,vault:{persistCredential:save}});
    if(f){f.setRead(read);f.setPersist(save);}
    const started=await manager.start({});assert.equal(started.status,201);
    const input={connectionId:started.body.data.connectionId};assert.equal((await manager.finish(input)).status,202);
    await turn();finalRead=false;assert.equal(stored,1);assert.ok(settlements.length>0);
    const result=await manager.status(input);assert.equal(result.status,200);
    if(settlements.at(-1)>=10){assert.equal(result.body.data.state,'unknown');assert.equal(result.body.data.reason,'ALEKOV_CONNECT_TIMEOUT');}
    else assert.equal(result.body.data.state,outcome==='valid'?'connected':'unknown');
  });
});

for(const kind of ['generic','native'])test(`${kind} late failed connector completion cannot replace a timeout with an earlier error`,async t=>{
  for(let depth=1;depth<=16;depth++)await t.test(`microtask depth ${depth}`,async t=>{
    const time=timing(t);let failed=false;const settlements=[];
    const options={finishTimeoutMs:10,clock:()=>{if(failed)settlements.push(time.now);return Date.now();},
      fetchImpl:async(url,options)=>{if(url.endsWith('/start'))return startedResponse(options);failed=true;time.after(depth,()=>time.set(11));return Response.json({}, {status:401});}};
    const manager=kind==='generic'?generic(t,options):(await native(t,options)).manager;
    const started=await manager.start({});assert.equal(started.status,201);const input={connectionId:started.body.data.connectionId};
    assert.equal((await manager.finish(input)).status,202);await turn();failed=false;
    const result=await manager.status(input);assert.equal(result.status,200);assert.ok(settlements.length>0);
    if(settlements.at(-1)>=10){assert.equal(result.body.data.state,'unknown');assert.equal(result.body.data.reason,'ALEKOV_CONNECT_TIMEOUT');}
    else assert.equal(result.body.data.reason,kind==='generic'?'ALEKOV_CONNECT_REJECTED':'ALEKOV_CONNECT_OUTCOME_UNKNOWN');
  });
});

for(const method of ['finish','cancel','status'])test(`native connected ${method} keeps its continuity lookup deadline through final publication`,async t=>{
  for(const outcome of ['valid','failed'])for(let depth=1;depth<=10;depth++)await t.test(`${outcome}, microtask depth ${depth}`,async t=>{
    const time=timing(t);let redeems=0;
    const f=await native(t,{fetchImpl:async(url,options)=>{if(url.endsWith('/start'))return startedResponse(options);redeems++;return credentialResponse();}});
    f.setPersist(async input=>persisted(input));
    const started=await f.manager.start({});assert.equal(started.status,201);const input={connectionId:started.body.data.connectionId};
    assert.equal((await f.manager.finish(input)).status,202);await turn();assert.equal((await f.manager.status(input)).body.data.state,'connected');
    const current={};f.setOpen(async()=>{time.after(depth,()=>time.set(5001));return current;});
    f.setContinuity(()=>{if(outcome==='failed')throw Error('fixture continuity changed');return context;});
    const result=await f.manager[method](input),at=time.publication(result);await turn();
    if(at>=5000)assert.equal(result.status,504,'expired continuity must not publish or overwrite a connected flow');
    else assert.equal(result.status,outcome==='valid'?200:409);
    assert.ok(f.closed.includes(current),'the temporary continuity capability must be closed');assert.equal(redeems,1,'lookup must not redeem again');
    f.setOpen(async()=>({}));f.setContinuity(()=>context);
    const observed=await f.manager.status(input);assert.equal(observed.status,200);
    assert.equal(observed.body.data.state,result.status===409?'unknown':'connected');
  });
});

test('native connected lookup timeout closes a capability that arrives after the request has ended',async t=>{
  const time=timing(t),f=await native(t,{fetchImpl:async(url,options)=>url.endsWith('/start')?startedResponse(options):credentialResponse()});
  f.setPersist(async input=>persisted(input));
  const started=await f.manager.start({});assert.equal(started.status,201);const input={connectionId:started.body.data.connectionId};
  assert.equal((await f.manager.finish(input)).status,202);await turn();assert.equal((await f.manager.status(input)).body.data.state,'connected');
  const gate=deferred(),reached=deferred(),lateCap={};let requestSignal;
  f.setOpen(async(_,call)=>{requestSignal=call.signal;reached.resolve();return gate.promise;});
  const pending=f.manager.status(input);
  try{
    // Advancing the scheduler alone does not advance the absolute monotonic deadline.
    await reachBeforeCompletion(pending,reached);time.set(5000);t.mock.timers.tick(5000);
    assert.equal((await pending).status,504);assert.equal(requestSignal.aborted,true);
  }finally{gate.resolve(lateCap);await pending;await turn();}
  assert.ok(f.closed.includes(lateCap));f.setOpen(async()=>({}));
  assert.equal((await f.manager.status(input)).body.data.state,'connected');
});

test('generic job budget starts at acceptance while native budget stays bound to capability opening',async t=>{
  for(const kind of ['generic','native'])await t.test(kind,async t=>{
    const time=timing(t);let stored=0,afterStoreReads=0;
    const read=async()=>{if(stored&&++afterStoreReads===2)time.set(11);return kind==='generic'?scope:context;};
    const save=async input=>{stored++;return persisted(input);};
    const options={finishTimeoutMs:10,fetchImpl:async(url,options)=>url.endsWith('/start')?startedResponse(options):credentialResponse()};
    const f=kind==='native'?await native(t,options):null;
    const manager=f?.manager??generic(t,{...options,scopeTimeoutMs:100,readServerScope:read,vault:{persistCredential:save}});
    if(f){f.setRead(read);f.setPersist(save);}
    const started=await manager.start({});assert.equal(started.status,201);time.set(8);
    const input={connectionId:started.body.data.connectionId},controller=new AbortController();
    assert.equal((await manager.finish(input,{signal:controller.signal})).status,202);controller.abort();await turn();
    assert.equal(stored,1);const result=await manager.status(input);assert.equal(result.status,200);
    assert.equal(result.body.data.state,kind==='generic'?'connected':'unknown');
    assert.equal(result.body.data.reason,kind==='generic'?null:'ALEKOV_CONNECT_TIMEOUT');
  });
});

test('generic lookup expires on a real timer without a resolving scope and leaves the flow unchanged', {timeout:3000},async t=>{
  let blocked=false,redeems=0;const gate=deferred(),reached=deferred();
  const manager=generic(t,{scopeTimeoutMs:250,readServerScope:async()=>{if(blocked){reached.resolve();return gate.promise;}return scope;},
    fetchImpl:async(url,options)=>{if(url.endsWith('/start'))return startedResponse(options);redeems++;return Response.json({}, {status:503});}});
  const started=await manager.start({});assert.equal(started.status,201);const input={connectionId:started.body.data.connectionId};blocked=true;
  const pending=manager.finish(input);
  try{await reachBeforeCompletion(pending,reached);assert.equal((await pending).status,504);}
  finally{blocked=false;gate.resolve(scope);await pending;await turn();}
  assert.equal(redeems,0);assert.equal((await manager.status(input)).body.data.state,'awaiting_approval');
});

test('generic lookup aborts without waiting for the scope source and cannot accept a later result', {timeout:3000},async t=>{
  let blocked=false,redeems=0;const gate=deferred(),reached=deferred();
  const manager=generic(t,{readServerScope:async()=>{if(blocked){reached.resolve();return gate.promise;}return scope;},
    fetchImpl:async(url,options)=>{if(url.endsWith('/start'))return startedResponse(options);redeems++;return Response.json({}, {status:503});}});
  const started=await manager.start({});assert.equal(started.status,201);const input={connectionId:started.body.data.connectionId};blocked=true;
  const controller=new AbortController(),pending=manager.finish(input,{signal:controller.signal});
  try{await reachBeforeCompletion(pending,reached);controller.abort();assert.equal((await pending).status,504);}
  finally{blocked=false;gate.resolve(scope);await pending;await turn();}
  assert.equal(redeems,0);assert.equal((await manager.status(input)).body.data.state,'awaiting_approval');
});

test('generic final lookup cannot publish a flow evicted while its scope observation was pending',async t=>{
  timing(t);let blockNext=false;const gate=deferred(),reached=deferred();
  const manager=generic(t,{maxFlows:1,readServerScope:async()=>{if(blockNext){blockNext=false;reached.resolve();return gate.promise;}return scope;}});
  const first=await manager.start({});assert.equal(first.status,201);const input={connectionId:first.body.data.connectionId};blockNext=true;
  const pending=manager.status(input);
  try{
    await reachBeforeCompletion(pending,reached);
    assert.equal((await manager.cancel(input)).body.data.state,'cancelled');
    const replacement=await manager.start({});assert.equal(replacement.status,201);
    gate.resolve(scope);
    assert.equal((await pending).status,404,'the old lookup must not publish its detached flow');
    assert.equal((await manager.status(input)).status,404);
    assert.equal((await manager.status({connectionId:replacement.body.data.connectionId})).status,200);
  }finally{gate.resolve(scope);await pending;}
});

test('native final lookup cannot revive a retained flow removed during the observation, even if the wall clock rolls back',async t=>{
  const time=timing(t);let wall=Date.now(),blockNext=false;const before=wall,gate=deferred(),reached=deferred();
  const f=await native(t,{maxFlows:2,retainMs:1,clock:()=>wall});
  f.setOpen(async()=>({}));f.setAssert((_,cap)=>{if(f.closed.includes(cap))throw Error('fixture operation closed');return context;});
  f.setRead(async()=>{if(blockNext){blockNext=false;reached.resolve();return gate.promise;}return context;});
  const first=await f.manager.start({});assert.equal(first.status,201);const input={connectionId:first.body.data.connectionId};blockNext=true;
  const pending=f.manager.status(input);
  try{
    await reachBeforeCompletion(pending,reached);assert.equal((await f.manager.cancel(input)).body.data.state,'cancelled');
    time.set(1);wall=before+1;const replacement=await f.manager.start({});assert.equal(replacement.status,201);wall=before;
    gate.resolve(context);assert.equal((await pending).status,404);
    assert.equal((await f.manager.status(input)).status,404);
    assert.equal((await f.manager.status({connectionId:replacement.body.data.connectionId})).status,200);
  }finally{gate.resolve(context);await pending;}
});

for(const kind of ['generic','native'])test(`${kind} final acceptance rechecks manager closure after the configured clock callback`,async t=>{
  timing(t);let armed=false,manager;
  const options={clock:()=>{if(armed)manager.close();return Date.now();}};
  manager=kind==='generic'?generic(t,options):(await native(t,options)).manager;
  const started=await manager.start({});assert.equal(started.status,201);armed=true;
  assert.equal((await manager.cancel({connectionId:started.body.data.connectionId})).status,503);assert.equal(manager.available,false);
});

test('native capability assertion cannot close the manager and then allow a new vault write',async t=>{
  let beforeWrite;
  for(const closeDuringAssertion of [false,true])await t.test(closeDuringAssertion?'close at the last native assertion before save':'observe the timely save boundary',async t=>{
    timing(t);let calls=0,writes=0;
    const f=await native(t,{fetchImpl:async(url,options)=>url.endsWith('/start')?startedResponse(options):credentialResponse()});
    f.setAssert(()=>{calls++;if(closeDuringAssertion&&calls===beforeWrite)f.manager.close();return context;});
    f.setPersist(async input=>{writes++;if(!closeDuringAssertion)beforeWrite=calls;return persisted(input);});
    const started=await f.manager.start({});assert.equal(started.status,201);calls=0;
    assert.equal((await f.manager.finish({connectionId:started.body.data.connectionId})).status,202);await turn();
    assert.equal(writes,closeDuringAssertion?0:1);if(closeDuringAssertion)assert.equal(f.manager.available,false);else assert.ok(beforeWrite>0);
  });
});

for(const kind of ['generic','native'])test(`${kind} capacity reclaims every terminal state without retrying completed work`,async t=>{
  for(const state of ['cancelled','error','unknown','connected'])await t.test(state,async t=>{
    timing(t);let wall=Date.now();
    const f=await capacityFixture(t,kind,{maxFlows:1,clock:()=>wall,
      ...(state==='unknown'?{fetchImpl:async(url,call)=>url.endsWith('/start')?startedResponse(call,wall):Response.json({}, {status:503})}:{})});
    const first=await f.manager.start({});assert.equal(first.status,201);const input={connectionId:first.body.data.connectionId};
    const beforeBusy={...f.calls};assert.equal((await f.manager.start({})).status,429);assert.deepEqual(f.calls,beforeBusy,'busy start must not begin identity, capability, fetch, or vault work');
    if(state==='cancelled')assert.equal((await f.manager.cancel(input)).body.data.state,state);
    else if(state==='error')wall+=60001;
    else{assert.equal((await f.manager.finish(input)).status,202);await turn();}
    assert.equal((await f.manager.status(input)).body.data.state,state);
    if(kind==='native')assert.ok(f.closed.includes(f.opened[0]),'terminal native capability must already be closed');
    const beforeRestart={...f.calls},replacement=await f.manager.start({});assert.equal(replacement.status,201);
    assert.equal(f.calls.starts,beforeRestart.starts+1);assert.equal(f.calls.redeems,beforeRestart.redeems);assert.equal(f.calls.writes,beforeRestart.writes);
    assert.equal((await f.manager.status(input)).status,404,'only the old terminal record is evicted');
    assert.equal((await f.manager.status({connectionId:replacement.body.data.connectionId})).body.data.state,'awaiting_approval');
  });
});

for(const kind of ['generic','native'])test(`${kind} capacity follows actual completion order despite wall adjustments and equal monotonic ticks`,async t=>{
  for(const delta of [-1000,1000])for(const equalTicks of [false,true])await t.test(`wall ${delta}, equal ticks ${equalTicks}`,async t=>{
    const time=timing(t);let wall=Date.now();const f=await capacityFixture(t,kind,{maxFlows:3,clock:()=>wall});
    const start=async()=>{const result=await f.manager.start({});assert.equal(result.status,201);return {connectionId:result.body.data.connectionId};};
    const a=await start(),b=await start();assert.equal((await f.manager.cancel(b)).body.data.state,'cancelled');
    const c=await start();assert.equal((await f.manager.status(b)).body.data.state,'cancelled','spare capacity must retain terminal history');
    wall+=delta;time.set(equalTicks?0:1);assert.equal((await f.manager.cancel(a)).body.data.state,'cancelled');
    // b was created later but completed first. Reading/cancelling it again must
    // not make it newer than a, even when both completed in the same tick.
    assert.equal((await f.manager.status(b)).body.data.state,'cancelled');assert.equal((await f.manager.cancel(b)).body.data.state,'cancelled');
    const d=await start();assert.equal((await f.manager.status(b)).status,404);
    assert.equal((await f.manager.status(a)).body.data.state,'cancelled','one free slot must not erase newer history');
    assert.equal((await f.manager.status(c)).body.data.state,'awaiting_approval');
    const e=await start();assert.equal((await f.manager.status(a)).status,404);
    for(const input of [c,d,e])assert.equal((await f.manager.status(input)).body.data.state,'awaiting_approval');
    const before={...f.calls};assert.equal((await f.manager.start({})).status,429);assert.deepEqual(f.calls,before);
  });
});

for(const kind of ['generic','native'])test(`${kind} capacity counts active flows together with pending starts and releases a cancelled start slot`,async t=>{
  timing(t);const gate=deferred(),reached=deferred();let startCalls=0,blockedCall;
  const f=await capacityFixture(t,kind,{maxFlows:2,fetchImpl:async(url,call)=>{
    assert.ok(url.endsWith('/start'));if(++startCalls===2){blockedCall=call;reached.resolve();return gate.promise;}return startedResponse(call);
  }});
  const active=await f.manager.start({});assert.equal(active.status,201);
  const controller=new AbortController(),pending=f.manager.start({},{signal:controller.signal});
  try{
    await reachBeforeCompletion(pending,reached);const before={...f.calls};
    assert.equal((await f.manager.start({})).status,429);assert.deepEqual(f.calls,before);
    assert.equal((await f.manager.cancel({connectionId:active.body.data.connectionId})).body.data.state,'cancelled');
    assert.equal((await f.manager.start({})).status,201,'terminal history can be reclaimed alongside an existing pending start');
    const stillFull={...f.calls};assert.equal((await f.manager.start({})).status,429);assert.deepEqual(f.calls,stillFull);
    controller.abort();assert.equal((await pending).status,504);
    if(kind==='native')assert.ok(f.closed.includes(f.opened[1]));
    assert.equal((await f.manager.start({})).status,201,'cancelled preparation must release its pending slot');
  }finally{controller.abort();gate.resolve(blockedCall?startedResponse(blockedCall):Response.json({}));await pending;await turn();}
  assert.equal(f.calls.starts,4);assert.equal(f.calls.redeems,0);assert.equal(f.calls.writes,0);
});

for(const kind of ['generic','native'])test(`${kind} capacity protects an active checking flow while reclaiming terminal history`,async t=>{
  timing(t);const gate=deferred(),reached=deferred();let requestSignal;
  const f=await capacityFixture(t,kind,{maxFlows:2,fetchImpl:async(url,call)=>{
    if(url.endsWith('/start'))return startedResponse(call);requestSignal=call.signal;reached.resolve();return gate.promise;
  }});
  const first=await f.manager.start({});assert.equal(first.status,201);const input={connectionId:first.body.data.connectionId};
  try{
    assert.equal((await f.manager.finish(input)).status,202);await reachBeforeCompletion(new Promise(()=>{}),reached);
    const second=await f.manager.start({});assert.equal(second.status,201);
    const before={...f.calls};assert.equal((await f.manager.start({})).status,429);assert.deepEqual(f.calls,before);assert.equal(requestSignal.aborted,false);
    assert.equal((await f.manager.cancel({connectionId:second.body.data.connectionId})).body.data.state,'cancelled');
    assert.equal((await f.manager.start({})).status,201);
    assert.equal((await f.manager.status(input)).body.data.state,'checking');assert.equal(requestSignal.aborted,false);assert.equal(f.calls.redeems,1);
  }finally{f.manager.close();gate.resolve(Response.json({}, {status:503}));await turn();}
  assert.equal(requestSignal.aborted,true);assert.equal(f.calls.writes,0);
});

for(const kind of ['generic','native'])test(`${kind} default capacity supports repeated explicit start and cancel cycles`,async t=>{
  timing(t);const f=await capacityFixture(t,kind),ids=[];
  for(let index=0;index<24;index++){
    const started=await f.manager.start({});assert.equal(started.status,201,`explicit start ${index+1}`);
    const input={connectionId:started.body.data.connectionId};ids.push(input);
    assert.equal((await f.manager.cancel(input)).body.data.state,'cancelled');
  }
  for(let index=0;index<ids.length;index++){
    const result=await f.manager.status(ids[index]);assert.equal(result.status,index<16?404:200);
    if(result.status===200)assert.equal(result.body.data.state,'cancelled');
  }
  assert.equal(f.calls.starts,24);assert.equal(f.calls.redeems,0);assert.equal(f.calls.writes,0);
  if(kind==='native')assert.equal(f.opened.filter(cap=>!f.closed.includes(cap)).length,0,'all cancelled capabilities must be closed');
});

test('native capacity eviction invalidates an in-flight connected lookup and closes its temporary capability',async t=>{
  timing(t);const f=await capacityFixture(t,'native',{maxFlows:1});
  const first=await f.manager.start({});assert.equal(first.status,201);const input={connectionId:first.body.data.connectionId};
  assert.equal((await f.manager.finish(input)).status,202);await turn();assert.equal((await f.manager.status(input)).body.data.state,'connected');
  const gate=deferred(),reached=deferred(),temporary={};let openNext=true,lookupSignal;
  f.setOpen(async(_,call)=>{if(openNext){openNext=false;lookupSignal=call.signal;reached.resolve();return gate.promise;}return {};});
  const pending=f.manager.status(input);
  try{
    await reachBeforeCompletion(pending,reached);const replacement=await f.manager.start({});assert.equal(replacement.status,201);
    gate.resolve(temporary);assert.equal((await pending).status,404,'a formerly connected observation cannot revive an evicted record');
    assert.equal(lookupSignal.aborted,true);assert.equal(f.closed.filter(cap=>cap===temporary).length,1);
    assert.equal((await f.manager.status(input)).status,404);assert.equal((await f.manager.status({connectionId:replacement.body.data.connectionId})).body.data.state,'awaiting_approval');
    assert.equal(f.calls.redeems,1);assert.equal(f.calls.writes,1,'reclaiming display history must not repeat or undo the completed save');
  }finally{gate.resolve(temporary);await pending;await turn();}
});

for(const kind of ['generic','native'])test(`${kind} terminal retention uses exact monotonic age and repeated reads cannot renew it`,async t=>{
  for(const state of ['cancelled','error','unknown','connected'])for(const delta of [-600001,600001])await t.test(`${state}, wall ${delta}`,async t=>{
    const time=timing(t);let wall=Date.now();
    const f=await capacityFixture(t,kind,{retainMs:100,clock:()=>wall,
      ...(state==='unknown'?{fetchImpl:async(url,call)=>url.endsWith('/start')?startedResponse(call,wall):Response.json({}, {status:503})}:{})});
    const started=await f.manager.start({});assert.equal(started.status,201);const input={connectionId:started.body.data.connectionId};
    if(state==='cancelled')await f.manager.cancel(input);
    else if(state==='error')wall=Date.parse(started.body.data.expiresAt);
    else{assert.equal((await f.manager.finish(input)).status,202);await turn();}
    assert.equal((await f.manager.status(input)).body.data.state,state);
    wall+=delta;assert.equal((await f.manager.status(input)).body.data.state,state,'wall corrections must not change relative retention');
    time.set(25);assert.equal((await f.manager.status(input)).body.data.state,state);
    time.set(75);assert.equal((await f.manager.cancel(input)).body.data.state,state);
    time.set(99.999);assert.equal((await f.manager.status(input)).body.data.state,state);
    time.set(100);assert.equal((await f.manager.status(input)).status,404,'retention must expire at the original exact monotonic boundary');
  });
});

for(const kind of ['generic','native'])test(`${kind} start prunes expired history by monotonic age without capacity pressure`,async t=>{
  for(const delta of [-600001,600001])await t.test(`wall ${delta}`,async t=>{
    const time=timing(t);let wall=Date.now();const f=await capacityFixture(t,kind,{maxFlows:3,retainMs:100,clock:()=>wall});
    const started=await f.manager.start({});assert.equal(started.status,201);const input={connectionId:started.body.data.connectionId};
    assert.equal((await f.manager.finish(input)).status,202);await turn();assert.equal((await f.manager.status(input)).body.data.state,'connected');
    wall+=delta;time.set(99.999);assert.equal((await f.manager.start({})).status,201);
    assert.equal((await f.manager.status(input)).body.data.state,'connected');
    time.set(100);assert.equal((await f.manager.start({})).status,201);
    const before={...f.calls};assert.equal((await f.manager.status(input)).status,404);
    assert.deepEqual(f.calls,before,'pruned history must not open a new capability or read identity before returning not-found');
  });
});

test('native connected-to-unknown transition resets monotonic retention once, regardless of wall direction',async t=>{
  for(const delta of [-600001,600001])await t.test(`wall ${delta}`,async t=>{
    const time=timing(t);let wall=Date.now();const f=await capacityFixture(t,'native',{retainMs:100,clock:()=>wall});
    const started=await f.manager.start({});assert.equal(started.status,201);const input={connectionId:started.body.data.connectionId};
    assert.equal((await f.manager.finish(input)).status,202);await turn();assert.equal((await f.manager.status(input)).body.data.state,'connected');
    time.set(40);wall+=delta;f.setContinuity(()=>{throw Error('fixture native continuity changed');});
    assert.equal((await f.manager.status(input)).status,409);
    time.set(100);assert.equal((await f.manager.status(input)).body.data.state,'unknown','a real reclassification starts its own retained age');
    time.set(139.999);assert.equal((await f.manager.cancel(input)).body.data.state,'unknown');
    time.set(140);assert.equal((await f.manager.status(input)).status,404,'repeated terminal access must not renew the reclassification');
  });
});

test('native connected-to-unknown transition receives a new completion order within the same monotonic tick',async t=>{
  timing(t);let wall=Date.now();const f=await capacityFixture(t,'native',{maxFlows:2,clock:()=>wall});
  const first=await f.manager.start({});assert.equal(first.status,201);const connected={connectionId:first.body.data.connectionId};
  assert.equal((await f.manager.finish(connected)).status,202);await turn();assert.equal((await f.manager.status(connected)).body.data.state,'connected');
  const second=await f.manager.start({});assert.equal(second.status,201);const cancelled={connectionId:second.body.data.connectionId};
  assert.equal((await f.manager.cancel(cancelled)).body.data.state,'cancelled');
  wall-=1000;f.setContinuity(()=>{throw Error('fixture native continuity changed');});assert.equal((await f.manager.status(connected)).status,409);
  assert.equal((await f.manager.start({})).status,201);
  assert.equal((await f.manager.status(cancelled)).status,404,'the earlier cancellation is older than the later reclassification');
  assert.equal((await f.manager.status(connected)).body.data.state,'unknown');assert.equal(f.calls.redeems,1);assert.equal(f.calls.writes,1);
});

for(const kind of ['generic','native'])test(`${kind} approval expiresAt remains an absolute wall-clock boundary`,async t=>{
  const time=timing(t);let wall=Date.now();const f=await capacityFixture(t,kind,{clock:()=>wall});
  const started=await f.manager.start({});assert.equal(started.status,201);const input={connectionId:started.body.data.connectionId},expiry=Date.parse(started.body.data.expiresAt);
  time.set(70000);wall=expiry-1;
  assert.equal((await f.manager.status(input)).body.data.state,'awaiting_approval','monotonic passage alone must not replace an external absolute expiry');
  wall=expiry;const expired=await f.manager.status(input);assert.equal(expired.status,200);
  assert.equal(expired.body.data.state,'error');assert.equal(expired.body.data.reason,'ALEKOV_CONNECT_EXPIRED');
});


for(const kind of ['generic','native'])for(const mode of ['early','equality','timely','cancel'])test(`C25 manager ${kind} waiter ${mode} retains its original deadline`,async t=>{
  const timers=controlledManagerTimers(t,{firstStartCost:0.25}),gate=deferred(),reached=deferred(),external=new AbortController();
  let fetches=0,outcome=null,requestSignal;
  const options={startTimeoutMs:100,finishTimeoutMs:1000,maxFlows:1,fetchImpl:async(_,call)=>{fetches++;return startedResponse(call);}};
  const f=kind==='native'?await native(t,options):null;
  const manager=f?.manager??generic(t,{...options,scopeTimeoutMs:100,readServerScope:async()=>{reached.resolve();return gate.promise;}});
  if(f)f.setOpen(async(_,call)=>{requestSignal=call.signal;reached.resolve();return gate.promise;});
  const pending=manager.start({},{signal:external.signal}).then(value=>{outcome=value;return value;});void pending.catch(()=>{});
  t.after(async()=>{manager.close();gate.resolve(f?.cap??scope);await turn();});await reachBeforeCompletion(pending,reached);
  assert.equal(timers.records.length,2);const [startTimer,waitTimer]=timers.records;
  assert.equal(waitTimer.createdAt,0.25);assert.ok(timers.active.has(startTimer));assert.ok(timers.active.has(waitTimer));
  let replacement;
  if(mode==='early'){
    timers.fire(waitTimer,99.25);await turn();assert.equal(outcome,null,'a pre-deadline wake must retain the blocked lookup');
    assert.equal(waitTimer.clears,1);replacement=timers.addedSince(new Set([startTimer]));assert.notEqual(replacement,waitTimer);
    assert.equal(replacement.delay,1);const active=new Set(timers.active);timers.repeat(waitTimer);assert.deepEqual(timers.active,active);assert.equal(waitTimer.clears,1);
  }
  if(mode==='equality'||mode==='cancel'){
    if(mode==='equality')timers.fire(waitTimer,100);else{timers.set(17.125);external.abort();}
    const result=await pending;assert.equal(result.status,504);assert.equal(result.body.error.code,'ALEKOV_CONNECT_DEADLINE');
    assert.equal(fetches,0);timers.assertReleased();const acquired=timers.records.length;timers.repeat(waitTimer);assert.equal(timers.records.length,acquired);
    gate.resolve(f?.cap??scope);await turn();assert.equal(fetches,0);
    if(f){assert.equal(requestSignal.aborted,true);assert.equal(f.closed.filter(cap=>cap===f.cap).length,1);f.setOpen(async()=>({}));}
    assert.equal((await manager.start({})).status,201,'timeout/cancellation returns the start capacity reservation');
  }else{
    timers.set(99.5);gate.resolve(f?.cap??scope);const result=await pending;assert.equal(result.status,201);assert.equal(fetches,1);
    assert.equal(startTimer.clears,1);assert.equal(waitTimer.clears,1);if(replacement)assert.equal(replacement.clears,1);
    if(f){assert.equal(requestSignal.aborted,false,'start cleanup must preserve the controller transferred to the native flow');assert.equal(f.closed.includes(f.cap),false);}
    assert.equal((await manager.start({})).status,429,'the accepted flow still occupies its one capacity slot');
  }
  manager.close();timers.assertReleased();if(f)assert.equal(f.closed.filter(cap=>cap===f.cap).length,1);
});

for(const kind of ['generic','native'])for(const mode of ['early-expiry','cancel','timely'])test(`C25 manager ${kind} flow ${mode} owns its unchanged job deadline`,async t=>{
  const timers=controlledManagerTimers(t),gate=deferred(),reached=deferred();let requestSignal;
  const f=await capacityFixture(t,kind,{finishTimeoutMs:100,startTimeoutMs:1000,
    fetchImpl:async(url,call)=>{if(url.endsWith('/start')){timers.set(0.25);return startedResponse(call);}
      requestSignal=call.signal;reached.resolve();return gate.promise;}});
  t.after(async()=>{f.manager.close();gate.resolve(credentialResponse());await turn();});
  const started=await f.manager.start({});assert.equal(started.status,201);const input={connectionId:started.body.data.connectionId};
  const flowDeadline=kind==='native'?100:timers.now+100,acceptedSignal=new AbortController();
  assert.equal((await f.manager.finish(input,{signal:acceptedSignal.signal})).status,202);acceptedSignal.abort();await reached.promise;
  assert.equal(requestSignal.aborted,false,'accepted background work is independent of its HTTP request');
  // Lookup timers have settled; the retained flow timer precedes connector work.
  const [flowTimer]=timers.active;assert.ok(flowTimer);let replacement=flowTimer;
  if(mode==='early-expiry'){
    const other=new Set([...timers.active].filter(token=>token!==flowTimer));
    timers.fire(flowTimer,flowDeadline-0.75);await turn();
    assert.equal((await f.manager.status(input)).body.data.state,'checking','early wake must not settle the live flow');
    assert.equal(requestSignal.aborted,false);assert.equal(flowTimer.clears,1);
    replacement=timers.addedSince(other);assert.notEqual(replacement,flowTimer);assert.equal(replacement.delay,1);
    const retained=new Set(timers.active);timers.repeat(flowTimer);assert.deepEqual(timers.active,retained);assert.equal(flowTimer.clears,1);
    timers.fire(replacement,flowDeadline);await turn();
  }else if(mode==='cancel'){
    timers.set(flowDeadline-0.75);assert.equal((await f.manager.cancel(input)).body.data.state,'unknown');await turn();
  }else{
    timers.set(flowDeadline-0.25);gate.resolve(credentialResponse());await turn();
  }
  const result=await f.manager.status(input);assert.equal(result.status,200);
  assert.equal(result.body.data.state,mode==='timely'?'connected':'unknown');
  assert.equal(result.body.data.reason,mode==='timely'?null:mode==='cancel'?'ALEKOV_CONNECT_CANCELLED':'ALEKOV_CONNECT_TIMEOUT');
  assert.equal(requestSignal.aborted,true);assert.equal(f.calls.writes,mode==='timely'?1:0);
  if(kind==='native')assert.equal(f.closed.filter(cap=>cap===f.opened[0]).length,1,'terminal settlement closes the exact retained capability');
  timers.assertReleased();const acquired=timers.records.length;timers.repeat(flowTimer);timers.repeat(replacement);
  assert.equal(timers.records.length,acquired);timers.assertReleased();
  gate.resolve(credentialResponse());await turn();assert.equal(f.calls.writes,mode==='timely'?1:0);
  assert.equal((await f.manager.status(input)).body.data.state,mode==='timely'?'connected':'unknown');
  f.manager.close();timers.assertReleased();
});

for(const kind of ['generic','native'])for(const mode of ['expiry-throw','close-multiple','expiry-reentry'])test(`C25 manager terminal ${kind} ${mode} cleans owners before optional time`,async t=>{
  const timers=controlledManagerTimers(t),gate=deferred(),wall=Date.now(),signals=[];let fault=false,observedBeforeReentry;
  const clock=()=>{
    if(fault){
      if(mode==='expiry-reentry'){
        fault=false;observedBeforeReentry={aborted:signals[0].aborted,closed:kind==='native'?f.closed.filter(cap=>cap===f.opened[0]).length:null};
        f.manager.close();
      }else throw Error('fixture terminal timestamp failed');
    }
    return wall;
  };
  const f=await capacityFixture(t,kind,{clock,finishTimeoutMs:100,startTimeoutMs:1000,retainMs:10,
    fetchImpl:async(url,call)=>{if(url.endsWith('/start'))return startedResponse(call,wall);
      signals.push(call.signal);await gate.promise;return credentialResponse();}});
  t.after(async()=>{fault=false;gate.resolve();await turn();f.manager.close();});
  const inputs=[];
  for(let index=0;index<(mode==='expiry-throw'?1:2);index++){
    const start=await f.manager.start({});assert.equal(start.status,201);const input={connectionId:start.body.data.connectionId};inputs.push(input);
    assert.equal((await f.manager.finish(input)).status,202);await turn();assert.equal(signals.length,index+1);
  }
  const [firstFlowTimer]=timers.active;assert.ok(firstFlowTimer);fault=true;let threw=false;
  try{if(mode==='close-multiple')f.manager.close();else timers.fire(firstFlowTimer,100);}catch{threw=true;}
  fault=false;
  assert.equal(threw,false,'optional observation failure must not escape terminal cleanup');
  assert.ok(signals.every(signal=>signal.aborted),'every owned transport is aborted before fallback cleanup');
  if(kind==='native')for(const cap of f.opened)assert.equal(f.closed.filter(value=>value===cap).length,1,'close each retained capability exactly once');
  if(mode==='expiry-reentry'){
    assert.equal(observedBeforeReentry.aborted,true,'the original expiry owns cleanup before the clock can reenter close');
    if(kind==='native')assert.equal(observedBeforeReentry.closed,1);
  }
  // The SDK releases its operation timer in the abort Promise.race/finally;
  // the unresolved source must not be needed for that cleanup to finish.
  await turn();
  timers.assertReleased();const allocated=timers.records.length;timers.repeat(firstFlowTimer);assert.equal(timers.records.length,allocated);
  if(mode==='expiry-throw'){
    const result=await f.manager.status(inputs[0]);assert.equal(result.status,200);assert.equal(result.body.data.state,'unknown');
    assert.equal(result.body.data.reason,'ALEKOV_CONNECT_TIMEOUT');
    timers.set(109.999);assert.equal((await f.manager.status(inputs[0])).status,200);
    timers.set(110);assert.equal((await f.manager.status(inputs[0])).status,404,'unavailable wall metadata must not replace monotonic retention');
  }else{
    assert.equal(f.manager.available,false);assert.equal((await f.manager.status(inputs[0])).status,503);
  }
  gate.resolve();await turn();assert.equal(f.calls.writes,0);timers.assertReleased();
});

for(const kind of ['generic','native'])for(const mode of ['timely','throw','deadline','close','rejected','rejected-throw'])test(`C25 manager terminal ${kind} completion ${mode} retains its decisive outcome`,async t=>{
  const timers=controlledManagerTimers(t),wall=Date.now();let manager,armed=false,samples=0,stored=0,afterStoreReads=0,requestSignal;
  const rejected=mode.startsWith('rejected');
  const clock=()=>{
    if(armed){armed=false;samples++;
      if(mode==='throw'||mode==='rejected-throw')throw Error('fixture completion timestamp failed');
      if(mode==='deadline')timers.set(100);
      if(mode==='close')manager.close();
    }
    return wall;
  };
  // The second post-save context read is the manager's final verification,
  // after the connector's last credential-expiry check. Arm only its metadata read.
  const read=async()=>{if(stored&&++afterStoreReads===2)armed=true;return kind==='native'?context:scope;};
  const save=async input=>{stored++;return persisted(input);};
  const options={clock,finishTimeoutMs:100,startTimeoutMs:1000,fetchImpl:async(url,call)=>{
    if(url.endsWith('/start'))return startedResponse(call,wall);requestSignal=call.signal;
    if(rejected){call.signal.addEventListener('abort',()=>{armed=true;},{once:true});return Response.json({},{status:403});}
    return credentialResponse();
  }};
  const f=kind==='native'?await native(t,options):null;
  manager=f?.manager??generic(t,{...options,readServerScope:read,vault:{persistCredential:save}});
  if(f){f.setRead(read);f.setPersist(save);}
  t.after(()=>{armed=false;manager.close();});
  const start=await manager.start({});assert.equal(start.status,201);const input={connectionId:start.body.data.connectionId};
  assert.equal((await manager.finish(input)).status,202);await turn();assert.equal(samples,1,'exercise exactly the intended completion clock boundary');
  assert.equal(stored,rejected?0:1);assert.equal(requestSignal.aborted,true);timers.assertReleased();
  if(f){assert.equal(f.closed.filter(cap=>cap===f.cap).length,1);f.setOpen(async()=>({}));}
  const result=await manager.status(input);
  if(mode==='close'){assert.equal(manager.available,false);assert.equal(result.status,503);}
  else{
    const state=mode==='deadline'?'unknown':rejected?(kind==='generic'?'error':'unknown'):'connected';
    const reason=mode==='deadline'?'ALEKOV_CONNECT_TIMEOUT':rejected?(kind==='generic'?'ALEKOV_CONNECT_REJECTED':'ALEKOV_CONNECT_OUTCOME_UNKNOWN'):null;
    assert.equal(result.status,200);assert.equal(result.body.data.state,state);assert.equal(result.body.data.reason,reason);
  }
  manager.close();timers.assertReleased();
});
