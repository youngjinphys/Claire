import assert from 'node:assert/strict';
import {getEventListeners} from 'node:events';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';
import {ownedDeadlineTimer} from '../public/deadline-timer.mjs';

const turn=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const source=await readFile(new URL('../src/server.mjs',import.meta.url),'utf8');
const functionsStart=source.indexOf('    function assertAlive(){');
const functionsEnd=source.indexOf('    async function call(',functionsStart);
assert.ok(functionsStart>=0&&functionsEnd>functionsStart);
const requestFunctions=source.slice(functionsStart,functionsEnd);
function routeBlock(path,first,finalizer){
  const branch=source.indexOf(`      if(req.method==='POST'&&url.pathname==='${path}'`);
  const start=source.indexOf(first,branch),end=source.indexOf(finalizer,start);
  assert.ok(branch>=0&&start>branch&&end>start);
  return source.slice(start,end+finalizer.length);
}
const routes={
  explain:routeBlock('/api/ai/explain','        const routeLimit=Math.min(aiTimeoutMs,requestTimeoutMs);',
    '        }finally{closeSdpIncidentOperation(sourceOperation);closeNativeHostOperation(nativeOperation);}'),
  check:routeBlock('/api/ai/check','        const routeLimit=Math.min(aiTimeoutMs,requestTimeoutMs);',
    '        }finally{closeNativeHostOperation(nativeOperation);}'),
  learner:routeBlock('/api/learner-support/gpt','        beginSupportDeadline(',
    '        }finally{closeNativeHostOperation(nativeOperation);}')
};

// Run the shipped request wrappers and complete acquisition-through-finally
// blocks. Capabilities and downstream dependencies are inert test values; no
// native authority, registry, credential store, SDP engine or AI service runs.
function fixture(t,{route='check',target='native',mode='timely',cleanupChangesCause=false}={}){
  let mono=0;
  const lifetime=new AbortController(),active=new Set(),gate=deferred(),reached=deferred();
  const caps={native:Object.freeze({synthetic:'native'}),incident:Object.freeze({synthetic:'incident'})};
  const opened={native:0,incident:0},closed={native:0,incident:0},reads={native:0,incident:0},cleanupListenerCounts=[];
  t.mock.method(globalThis,'setTimeout',(callback,delay)=>{const token={callback,delay};active.add(token);return token;});
  t.mock.method(globalThis,'clearTimeout',token=>active.delete(token));
  const error=code=>Object.assign(new Error(code),{code});
  function open(kind,call){
    assert.equal(call.signal,lifetime.signal);opened[kind]++;
    if(kind!==target)return caps[kind];
    reached.resolve();
    if(mode==='late-cancel')return gate.promise.then(()=>caps[kind]);
    if(mode==='cancel')queueMicrotask(()=>lifetime.abort());
    if(mode==='deadline')queueMicrotask(()=>{mono=100;});
    return Promise.resolve(caps[kind]);
  }
  function close(kind,value){
    if(value===null||value===undefined)return;
    assert.equal(value,caps[kind]);closed[kind]++;
    if(cleanupChangesCause&&kind===target){
      cleanupListenerCounts.push(getEventListeners(lifetime.signal,'abort').length);
      mono=100;lifetime.abort();throw error('SYNTHETIC_DISPOSAL_FAILURE');
    }
  }
  const state={ownedDeadlineTimer,lifetime,requestStartedAt:{wall:100000,monotonic:0},requestTimeoutMs:1000,aiTimeoutMs:100,
    req:{headers:{}},res:{destroyed:false},performance:{now:()=>mono},Date:{now:()=>100000},
    nativeHost:Object.freeze({synthetic:'host'}),sdpHostEngine:Object.freeze({synthetic:'engine'}),engineError:error,
    jsonBody:async()=>({}),isLearnerSupportProblemKind:()=>true,isOwnedSdpHostEngine:()=>true,
    openNativeHostOperation(_host,call){return open('native',call);},
    openSdpIncidentOperation(_engine,_input,call){return open('incident',call);},
    readNativeHostOperation(){reads.native++;if(target==='incident')return {};throw error('NATIVE_HOST_UNVERIFIED');},
    assertSdpIncidentOperation(){reads.incident++;throw error('ON_AI_PROVISIONING_PENDING');},
    closeNativeHostOperation(value){close('native',value);},
    closeSdpIncidentOperation(value){close('incident',value);},
    createNativeOperationVault(){assert.fail('acquisition controls must stop before credential or AI work');}
  };
  const actual=runInNewContext(`let supportDeadline,supportTimer,requestTimedOut=false;
    ${requestFunctions}
    ({bounded,async run(){${routes[route]}},dispose(){supportTimer?.dispose();lifetime.abort();}});`,state);
  t.after(async()=>{actual.dispose();gate.resolve();await turn();assert.equal(active.size,0);});
  return {actual,lifetime,caps,opened,closed,reads,gate,reached,cleanupListenerCounts};
}

const acquisitions=[
  {name:'native explain',route:'explain',target:'native',mode:'cancel'},
  {name:'incident explain',route:'explain',target:'incident',mode:'deadline'},
  {name:'native check',route:'check',target:'native',mode:'late-cancel'},
  {name:'native learner support',route:'learner',target:'native',mode:'cancel'}
];
for(const item of acquisitions){
  test(`${item.name} transfers a timely acquisition to its existing route finalizer`,async t=>{
    const f=fixture(t,{...item,mode:'timely'});
    await assert.rejects(f.actual.run(),{code:'ON_AI_PROVISIONING_PENDING'});
    assert.equal(f.opened[item.target],1);assert.equal(f.reads[item.target],1);
    assert.equal(f.closed.native,1);assert.equal(f.closed.incident,item.target==='incident'?1:0);
    assert.equal(getEventListeners(f.lifetime.signal,'abort').length,0);
  });
  test(`${item.name} discards an acquired value lost to ${item.mode}`,async t=>{
    const f=fixture(t,item),pending=f.actual.run();void pending.catch(()=>{});
    if(item.mode==='late-cancel'){await f.reached.promise;f.lifetime.abort();}
    await assert.rejects(pending,{code:item.mode==='deadline'?'REQUEST_TIMEOUT':'REQUEST_CANCELLED'});
    if(item.mode==='late-cancel'){
      assert.equal(f.closed[item.target],0,'the unresolved supplier has not acquired a value yet');
      f.gate.resolve();await turn();
    }
    assert.equal(f.opened[item.target],1);assert.equal(f.reads[item.target],0);
    assert.equal(f.closed.native,1);assert.equal(f.closed.incident,item.target==='incident'?1:0);
    assert.equal(getEventListeners(f.lifetime.signal,'abort').length,0);
  });
}

// One cleanup/first-cause control applied to the three acquisition adapters.
// Disposal deliberately crosses the deadline, reenters cancellation and throws;
// none of these later events may replace the already decisive cancellation.
for(const route of ['explain','check','learner'])test(`${route} acquisition preserves the first cancellation through disposal reentry`,async t=>{
  const f=fixture(t,{route,mode:'cancel',cleanupChangesCause:true});
  await assert.rejects(f.actual.run(),{code:'REQUEST_CANCELLED'});
  assert.equal(f.reads.native,0);assert.equal(f.closed.native,1);
  assert.deepEqual(f.cleanupListenerCounts,[0],'retire the request listener before disposal reentry');
});

for(const phase of ['before call','before dispatch'])test(`request acquisition cancelled ${phase} starts no work and discards nothing`,async t=>{
  const f=fixture(t);let opened=0,closed=0;
  if(phase==='before call')f.lifetime.abort();
  const pending=f.actual.bounded(()=>{opened++;return f.caps.native;},()=>{closed++;});
  if(phase==='before dispatch')f.lifetime.abort();
  await assert.rejects(pending,{code:'REQUEST_CANCELLED'});
  assert.equal(opened,0);assert.equal(closed,0);assert.equal(getEventListeners(f.lifetime.signal,'abort').length,0);
});

test('a late supplier rejection remains observed after request cancellation',async t=>{
  const f=fixture(t);let closed=0;
  const pending=f.actual.bounded(()=>f.gate.promise,()=>{closed++;});void pending.catch(()=>{});
  await turn();f.lifetime.abort();await assert.rejects(pending,{code:'REQUEST_CANCELLED'});
  f.gate.reject(new Error('synthetic late rejection'));await turn();
  assert.equal(closed,0);assert.equal(getEventListeners(f.lifetime.signal,'abort').length,0);
});

test('plain values and transferred falsy values retain their value without disposal',async t=>{
  const f=fixture(t);let closed=0;
  const plain=Object.freeze({synthetic:'plain'});
  assert.equal(await f.actual.bounded(()=>plain),plain);
  for(const value of [undefined,null,false,0,''])assert.equal(await f.actual.bounded(()=>value,()=>{closed++;}),value);
  f.lifetime.abort();await turn();assert.equal(closed,0);
});

test('a lost falsy acquisition is disposed exactly once',async t=>{
  const f=fixture(t),closed=[];
  await assert.rejects(f.actual.bounded(()=>{f.lifetime.abort();return null;},value=>closed.push(value)),{code:'REQUEST_CANCELLED'});
  await turn();assert.deepEqual(closed,[null]);
});

test('a supplier failure without an acquired value preserves its identity and performs no disposal',async t=>{
  const f=fixture(t),failure=new Error('synthetic supplier rejection');let closed=0;
  await assert.rejects(f.actual.bounded(()=>Promise.reject(failure),()=>{closed++;}),error=>error===failure);
  assert.equal(closed,0);assert.equal(getEventListeners(f.lifetime.signal,'abort').length,0);
});
