import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {test} from 'node:test';
import {ownedDeadlineTimer} from '../public/deadline-timer.mjs';
import {createOnServer} from '../src/server.mjs';

// Exercise the shipped request timer closures without constructing a native host
// capability or invoking a registry, credential store or AI service.
const source=await readFile(new URL('../src/server.mjs',import.meta.url),'utf8');
const functionsStart=source.indexOf('    function assertAlive(){');
const functionsEnd=source.indexOf('    async function bounded(',functionsStart);
assert.ok(functionsStart>=0&&functionsEnd>functionsStart);
const requestFunctions=source.slice(functionsStart,functionsEnd);
const blocks=[];let offset=0;
while((offset=source.indexOf('        const routeLimit=Math.min(aiTimeoutMs,requestTimeoutMs);',offset))>=0){
  const end=source.indexOf('        let nativeOperation=null',offset);
  assert.ok(end>offset);blocks.push(source.slice(offset,end));offset=end;
}
assert.equal(blocks.length,2);
const supportLine=source.match(/^        beginSupportDeadline\(\{wall:Date\.now\(\)\+aiTimeoutMs,monotonic:performance\.now\(\)\+aiTimeoutMs\}\);$/m);
assert.ok(supportLine);blocks.push(supportLine[0]);

for(const [index,route] of ['native explain','native check','learner support'].entries()){
  for(const mode of ['early','equality','wall expiry','cancel','disposed']){
    test(`${route} request timer closure: ${mode}`,t=>{
      let mono=0.25,wall=100000;
      const lifetime=new AbortController(),records=[],active=new Set();
      t.mock.method(globalThis,'setTimeout',(callback,delay)=>{
        const token={callback,delay,clears:0};records.push(token);active.add(token);return token;
      });
      t.mock.method(globalThis,'clearTimeout',token=>{token.clears++;active.delete(token);});
      const state={ownedDeadlineTimer,lifetime,aiTimeoutMs:100,requestTimeoutMs:1000,
        requestStartedAt:{wall:100000,monotonic:0},res:{destroyed:false},
        performance:{now:()=>mono},Date:{now:()=>wall},
        engineError:code=>Object.assign(new Error(code),{code})};
      const actual=runInNewContext(`let supportDeadline,supportTimer,requestTimedOut=false;
        ${requestFunctions}
        ${blocks[index]}
        ({get timedOut(){return requestTimedOut;},get deadline(){return supportDeadline;},
          childBudget:typeof remaining==='function'?remaining:null,
          dispose(){supportTimer.dispose();}});`,state);
      t.after(()=>actual.dispose());
      assert.equal(active.size,1);assert.equal(records[0].delay,100);
      const ceiling=actual.deadline.monotonic;
      assert.equal(ceiling,index<2?100:100.25);
      if(actual.childBudget)assert.equal(actual.childBudget(),100);
      const first=records[0];
      if(mode==='early'){
        for(const at of [ceiling-0.75,ceiling-0.25]){
          mono=at;const [token]=active;token.callback();
          assert.equal(token.clears,1);assert.equal(active.size,1);
          assert.equal(lifetime.signal.aborted,false);assert.equal(actual.timedOut,false);
          assert.equal(actual.deadline.monotonic,ceiling,'an early wake cannot renew the original ceiling');
          if(actual.childBudget)assert.equal(actual.childBudget(),1);
        }
      }else if(mode==='equality'||mode==='wall expiry'){
        if(mode==='equality')mono=ceiling;else wall=actual.deadline.wall;
        first.callback();assert.equal(actual.timedOut,true);assert.equal(lifetime.signal.aborted,true);
        assert.equal(active.size,0);
      }else if(mode==='cancel'){
        mono=ceiling-0.5;lifetime.abort();first.callback();
        assert.equal(actual.timedOut,false,'cancellation while time remains is not a deadline failure');
        assert.equal(active.size,0);
      }else{
        actual.dispose();mono=ceiling;first.callback();
        assert.equal(actual.timedOut,false);assert.equal(lifetime.signal.aborted,false);
        assert.equal(active.size,0);
      }
      actual.dispose();assert.equal(active.size,0);
      const acquired=records.length;for(const token of records){assert.equal(token.clears,1);token.callback();}
      assert.equal(records.length,acquired,'retired callbacks cannot acquire another timer');
    });
  }
}

test('the shared browser deadline dependency is served as the exact JavaScript asset',async t=>{
  const server=createOnServer();
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const origin=`http://127.0.0.1:${server.address().port}`;
  const response=await fetch(origin+'/deadline-timer.mjs');
  assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/^text\/javascript/u);
  assert.match(response.headers.get('cache-control'),/no-store/u);
  assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  assert.equal(await response.text(),await readFile(new URL('../public/deadline-timer.mjs',import.meta.url),'utf8'));
  const wrong=await fetch(origin+'/deadline-timer.mjs?retry=1');
  assert.equal(wrong.status,400);assert.equal((await wrong.json()).error.code,'QUERY_REJECTED');
});

// The acquired capability is synthetic; only the real request wrapper and
// route adapter run here. No native host authority is manufactured or invoked.
const boundedEnd=source.indexOf('    async function call(',functionsStart);
assert.ok(boundedEnd>functionsEnd);
const boundedFunctions=source.slice(functionsStart,boundedEnd);
const acquisitionLines=source.split(/\r?\n/).filter(line=>line.startsWith(
  '        if(nativeHost){try{nativeOperation=await bounded(signal=>openNativeHostOperation('));
assert.equal(acquisitionLines.length,1);
for(const mode of ['deadline','cancel','unverified','timely']){
  test(`learner-support native acquisition preserves ${mode} outcome`,async()=>{
    let mono=0,closed=0;const lifetime=new AbortController(),cap=Object.freeze({synthetic:true});
    const state={lifetime,requestStartedAt:{wall:100000,monotonic:0},requestTimeoutMs:1000,
      res:{destroyed:false},performance:{now:()=>mono},Date:{now:()=>100000},
      aiTimeoutMs:100,nativeHost:Object.freeze({synthetic:true}),
      engineError:code=>Object.assign(new Error(code),{code}),
      openNativeHostOperation(_host,options){
        assert.equal(options.signal,lifetime.signal);
        if(mode==='deadline')mono=100;
        else if(mode==='cancel')lifetime.abort();
        else if(mode==='unverified')throw Object.assign(new Error('synthetic unavailable host'),{code:'NATIVE_HOST_UNVERIFIED'});
        return cap;
      },
      closeNativeHostOperation(value){assert.equal(value,cap);closed++;}};
    const actual=runInNewContext(`let supportDeadline={wall:100100,monotonic:100},supportTimer,requestTimedOut=false;
      ${boundedFunctions}
      (async()=>{let nativeOperation=null;${acquisitionLines[0]}return nativeOperation;});`,state);
    if(mode==='timely'){
      assert.equal(await actual(),cap);assert.equal(closed,0,'the successful caller receives ownership');
      state.closeNativeHostOperation(cap);assert.equal(closed,1);
    }else{
      await assert.rejects(actual(),{code:mode==='deadline'?'REQUEST_TIMEOUT':mode==='cancel'?'REQUEST_CANCELLED':'ON_AI_PROVISIONING_PENDING'});
      assert.equal(closed,mode==='unverified'?0:1);
    }
  });
}
