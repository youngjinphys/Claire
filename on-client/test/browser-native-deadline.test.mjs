import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createNativeDeadline,createNativeFetchTransport,NATIVE_ACTION_MS} from '../public/ai-connect.mjs';

const turn=()=>new Promise(resolve=>setImmediate(resolve));

// Record each actual returned token. Selecting a timer by its requested delay
// would hide changes in the remaining budget and miss replacement ownership.
function fixture(t,{constantRemaining,onFirstRead,onReaderCancel}={}){
  let mono=0,leftReads=0,fetches=0,fetchSignal,outcome,delivered=false,bodyDiscards=0,nextRead;
  const records=new Map(),active=new Set(),external=new AbortController(),realClear=globalThis.clearTimeout;
  t.mock.method(performance,'now',()=>mono);
  t.mock.method(globalThis,'setTimeout',(callback,delay,...args)=>{
    const token=Object.freeze({id:records.size+1});
    records.set(token,{callback,delay,args,clears:0});active.add(token);return token;
  });
  t.mock.method(globalThis,'clearTimeout',token=>{
    const record=records.get(token);
    if(record){record.clears++;active.delete(token);}else realClear(token);
  });
  const absolute=createNativeDeadline(60,{clock:()=>100000+Math.floor(mono),monotonic:()=>mono});
  const control={setMono:value=>{mono=value;},abort:()=>external.abort(),nextRead:fn=>{nextRead=fn;}};
  if(onFirstRead)nextRead=onFirstRead;
  const deadline={left(){
    leftReads++;const action=nextRead;nextRead=null;action?.(control);
    return constantRemaining===undefined?absolute.left():constantRemaining;
  }};
  let deliver;
  const response=new Promise(resolve=>{deliver=resolve;});
  mono=0.25;
  const pending=createNativeFetchTransport({fetchImpl:(_url,options)=>{
    fetches++;fetchSignal=options.signal;return response;
  }})('status',{signal:external.signal,deadline}).then(value=>{outcome=value;return value;});
  function reply(value=Response.json({ok:true,data:{state:'disconnected',expiresAtMs:null,approvalUrl:null,confirmation:null}})){
    assert.equal(delivered,false);delivered=true;
    const cancel=value.body.cancel.bind(value.body);
    value.body.cancel=(...args)=>{bodyDiscards++;return cancel(...args);};
    if(onReaderCancel){
      const acquire=value.body.getReader.bind(value.body);
      value.body.getReader=(...args)=>{
        const reader=acquire(...args),release=reader.cancel.bind(reader);
        reader.cancel=(...cancelArgs)=>{onReaderCancel(control);return release(...cancelArgs);};return reader;
      };
    }
    deliver(value);
  }
  const onlyToken=()=>{assert.equal(active.size,1);return [...active][0];};
  const fire=token=>{const record=records.get(token);record.callback(...record.args);};
  const clean=()=>{
    assert.equal(active.size,0,'all owned timers are gone before fallback cleanup');
    for(const record of records.values())assert.equal(record.clears,1,'each actual acquired token is cleared exactly once');
  };
  t.after(async()=>{external.abort();if(fetches&&!delivered)reply();await pending;await turn();});
  return {...control,pending,reply,fire,onlyToken,clean,records,active,
    get outcome(){return outcome;},get fetches(){return fetches;},get signal(){return fetchSignal;},
    get reads(){return leftReads;},get discards(){return bodyDiscards;}};
}

test('native browser transport rearms repeated early wakes and accepts a timely response',async t=>{
  const f=fixture(t);
  for(const at of [19.25,59.25]){
    const token=f.onlyToken();f.setMono(at);f.fire(token);await turn();
    assert.equal(f.outcome,undefined);assert.equal(f.signal.aborted,false);
    assert.notEqual(f.onlyToken(),token,'an early wake acquires a new owned token');
  }
  f.setMono(59.5);f.reply();assert.equal((await f.pending).ok,true);await turn();
  f.clean();assert.equal(f.fetches,1);assert.equal(f.discards,0);
});

test('native browser transport expires at equality and discards a late response once',async t=>{
  const f=fixture(t);f.setMono(60);f.fire(f.onlyToken());await turn();
  assert.equal(f.outcome?.error.code,'NATIVE_LOGIN_CLIENT_TIMEOUT');assert.equal(f.signal.aborted,true);
  f.setMono(60.25);f.reply();await f.pending;await turn();f.clean();assert.equal(f.discards,1);
});

test('native browser transport accepts a timely response without a timer wake',async t=>{
  const f=fixture(t);f.setMono(59.5);f.reply();assert.equal((await f.pending).ok,true);await turn();
  f.clean();assert.equal(f.fetches,1);assert.equal(f.discards,0);
});

test('native browser transport preserves its original local cap when external time stays positive',async t=>{
  const f=fixture(t,{constantRemaining:60000}),end=0.25+NATIVE_ACTION_MS;
  const first=f.onlyToken();
  f.setMono(end-0.25);f.fire(first);await turn();
  assert.equal(f.outcome,undefined);assert.equal(f.signal.aborted,false);
  const last=f.onlyToken();assert.notEqual(last,first);
  f.setMono(end);f.fire(last);await turn();
  assert.equal(f.outcome?.error.code,'NATIVE_LOGIN_CLIENT_TIMEOUT');
  f.reply();await f.pending;await turn();f.clean();assert.equal(f.discards,1);
});

test('native browser transport includes its initial supplied clock work in the local cap',async t=>{
  const f=fixture(t,{constantRemaining:60000,onFirstRead:({setMono})=>setMono(0.25+NATIVE_ACTION_MS)});
  if(f.fetches)f.reply();
  assert.equal((await f.pending).error?.code,'NATIVE_LOGIN_CLIENT_TIMEOUT');
  assert.equal(f.fetches,0);f.clean();
});

test('native browser transport resamples its local cap after the final supplied clock read',async t=>{
  let cleanupCalls=0;
  const f=fixture(t,{constantRemaining:60000,onReaderCancel:({nextRead})=>{
    cleanupCalls++;nextRead(({setMono})=>setMono(0.25+NATIVE_ACTION_MS));
  }});
  f.reply();const result=await f.pending;await turn();
  assert.equal(cleanupCalls,1);assert.equal(result.error?.code,'NATIVE_LOGIN_CLIENT_TIMEOUT');
  assert.equal(f.signal.aborted,true);f.clean();
});

test('native browser transport cancels during the initial supplied clock without dispatch',async t=>{
  const f=fixture(t,{constantRemaining:60000,onFirstRead:({abort})=>abort()});
  assert.equal((await f.pending).error?.code,'NATIVE_LOGIN_CANCELLED');
  assert.equal(f.fetches,0);f.clean();
});

test('native browser transport owns cancellation during a wake and ignores stale callbacks after disposal',async t=>{
  const f=fixture(t,{constantRemaining:60000}),token=f.onlyToken();
  f.nextRead(({abort})=>abort());f.setMono(10);f.fire(token);await turn();
  assert.equal(f.outcome?.error.code,'NATIVE_LOGIN_CANCELLED');assert.equal(f.signal.aborted,true);f.clean();
  const reads=f.reads,tokens=f.records.size;
  f.fire(token);await turn();assert.equal(f.reads,reads);assert.equal(f.records.size,tokens);f.clean();
  f.reply();await f.pending;await turn();assert.equal(f.discards,1);assert.equal(f.fetches,1);f.clean();
});

test('native browser transport preserves a confirmed HTTP denial after its status callback consumes the cap',async t=>{
  const f=fixture(t,{constantRemaining:60000});
  const response=new Response('not mounted',{status:404,headers:{'content-type':'text/html'}});
  Object.defineProperty(response,'status',{get(){f.setMono(0.25+NATIVE_ACTION_MS);return 404;}});
  f.reply(response);assert.equal((await f.pending).error?.code,'NATIVE_LOGIN_NOT_MOUNTED');await turn();
  f.clean();assert.equal(f.discards,1);
});
