import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import * as connectionModule from '../public/ai-connect.mjs';
import { createResponseLifetime } from '../public/http-response.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
class Element {
  constructor(){this.dataset={};this.attributes=new Map();this.children=[];this._text='';this.disabled=false;this.hidden=false;}
  set textContent(value){this._text=String(value);this.children=[];}
  get textContent(){return this._text+this.children.map(child=>child.textContent??String(child)).join('');}
  setAttribute(name,value){this.attributes.set(name,String(value));}
  removeAttribute(name){this.attributes.delete(name);}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this._text='';this.children=children;}
  addEventListener(){}
}
async function fixture(load,loadStudent=()=>Promise.resolve({createStudentView:()=>({})}),{fetch:fetchImpl,now=()=>0}={}){
  const elements=new Map(),timers=new Map();let sequence=0,fetches=0;
  const node=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  const context=vm.createContext({
    document:{getElementById:node,createElement:()=>new Element()},window:{},Node:Element,Element,
    createResponseLifetime,AbortController,TextDecoder,performance:{now},
    setTimeout(fn,delay){const id=++sequence;timers.set(id,{fn,delay});return id;},clearTimeout(id){timers.delete(id);},
    loadConnectFixture:load,loadStudentFixture:loadStudent,fetch:(...args)=>{fetches++;if(fetchImpl)return fetchImpl(...args);throw Error('Module loading must not authenticate');},
  });
  const original=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const source=original.replace(/^import \{[^\n]+\} from '\/vulnerabilities-view\.mjs';$/mu,'')
    .replace(/^import \{[^\n]+\} from '\.\/http-response\.mjs';$/mu,'')
    .replace("import('/ai-connect.mjs')",'loadConnectFixture()').replace('import(STUDENT_MODULE)','loadStudentFixture()')
    .replace(/\ninit\(\);\s*$/u,'');
  vm.runInContext(source,context);
  return {context,node,timers,get fetches(){return fetches;},request:(options)=>vm.runInContext('request',context)('/api/me',options),run:()=>vm.runInContext('loadConnectModule()',context)};
}

function assertUnavailable(x){
  assert.equal(vm.runInContext('aiConnectLoadFailed',x.context),true);
  for(const id of ['ai-connect-result','native-login-result']){
    assert.match(x.node(id).textContent,/불러오지 못했습니다/u);
    assert.match(x.node(id).textContent,/브라우저 새로고침/u);
    assert.doesNotMatch(x.node(id).textContent,/이 앱 버전|PRIVATE_|미연결/u);
  }
  assert.equal(x.node('ai-connect-start').disabled,true);
  assert.equal(x.node('native-login-start').disabled,true);
  assert.equal(x.fetches,0);
}

test('a rejected connection module shows loading failure and an explicit page-reload recovery',async()=>{
  const x=await fixture(()=>Promise.reject(Error('PRIVATE_MODULE_ERROR')));
  await x.run();assertUnavailable(x);assert.equal(x.timers.size,0);
  vm.runInContext('showConnectHelp()',x.context);
  assert.match(x.node('ai-connect-help-output').textContent,/CONNECTION_UI_LOAD_FAILED/u);
  assert.doesNotMatch(x.node('ai-connect-help-output').textContent,/NOT_MOUNTED|PRIVATE_/u);
});

test('a stalled import reaches a terminal state and late resolution never constructs controllers',async()=>{
  const pending=deferred();let constructed=0;
  const x=await fixture(()=>pending.promise),result=x.run();
  const timer=[...x.timers.values()].find(timer=>timer.delay===10000);assert.ok(timer);
  timer.fn();await result;assertUnavailable(x);
  pending.resolve({...connectionModule,createAiConnectController(){constructed++;throw Error('must not run');}});
  await tick();await tick();
  assert.equal(constructed,0);assertUnavailable(x);assert.equal(x.timers.size,0);
});

test('a controller construction failure cleans the partially initialized view',async()=>{
  let reset=0;
  const x=await fixture(()=>Promise.resolve({...connectionModule,
    createAiConnectController:()=>({reset(){reset++;}}),
    createNativeLoginController(){throw Error('PRIVATE_CONSTRUCTOR_ERROR');},
  }));
  await x.run();assertUnavailable(x);assert.equal(reset,1);
  assert.equal(vm.runInContext('aiConnect',x.context),null);
  assert.equal(vm.runInContext('nativeLogin',x.context),null);
});

test('a valid module enables local controls without initiating native login or AI approval',async()=>{
  const x=await fixture(()=>Promise.resolve(connectionModule));
  await x.run();
  assert.equal(vm.runInContext('aiConnectLoadFailed',x.context),false);
  assert.equal(x.node('ai-connect-start').disabled,false);
  assert.equal(x.node('native-login-start').disabled,false);
  assert.equal(x.fetches,0);assert.equal(x.timers.size,0);
});

for(const failure of ['rejected','stalled'])test(`${failure} student import ends with explicit reload guidance and never initializes late`,async()=>{
  const pending=deferred();let created=0;
  const x=await fixture(()=>Promise.resolve(connectionModule),()=>failure==='rejected'?Promise.reject(Error('PRIVATE_STUDENT_ERROR')):pending.promise);
  const done=vm.runInContext('loadStudentModule()',x.context);
  if(failure==='stalled'){
    const timer=[...x.timers.values()].find(timer=>timer.delay===10000);assert.ok(timer);timer.fn();
  }
  await done;
  assert.equal(vm.runInContext('studentLoadFailed',x.context),true);
  assert.match(x.node('student-status').textContent,/불러오지 못했습니다.*브라우저 새로고침/u);
  assert.doesNotMatch(x.node('student-status').textContent,/PRIVATE_|학생 구현 대기/u);
  pending.resolve({createStudentView(){created++;return {};}});await tick();await tick();
  assert.equal(created,0);assert.equal(x.fetches,0);assert.equal(x.timers.size,0);
});

test('an import resolving after its monotonic deadline cannot initialize when the timer is delayed',async()=>{
  let now=0,created=0;
  const x=await fixture(()=>{now=10001;return Promise.resolve({...connectionModule,createAiConnectController(){created++;return {};}});},undefined,{now:()=>now});
  await x.run();assertUnavailable(x);assert.equal(created,0);
});

test('app request headers timeout settles UI and cancels late response bodies',async()=>{
  const pending=deferred();let signal,cancelled=0;
  const x=await fixture(undefined,undefined,{fetch:(_path,options)=>{signal=options.signal;return pending.promise;}});
  const done=x.request({timeoutMs:10});
  [...x.timers.values()].find(timer=>timer.delay===10).fn();
  const result=await done;assert.equal(result.error.code,'TIMEOUT');assert.equal(signal.aborted,true);
  pending.resolve(new Response(new ReadableStream({cancel(){cancelled++;return new Promise(()=>{});}}),{headers:{'content-type':'application/json'}}));
  await tick();await tick();assert.equal(cancelled,1);assert.equal(x.timers.size,0);
});

test('app request body timeout does not await an uncooperative cancellation promise',async()=>{
  let cancelled=0;
  const x=await fixture(undefined,undefined,{fetch:()=>Promise.resolve(new Response(new ReadableStream({cancel(){cancelled++;return new Promise(()=>{});}}),{headers:{'content-type':'application/json'}}))});
  const done=x.request({timeoutMs:10});await tick();
  [...x.timers.values()].find(timer=>timer.delay===10).fn();
  assert.equal((await done).error.code,'TIMEOUT');assert.equal(cancelled,1);assert.equal(x.timers.size,0);
});

test('app request cancellation is immediate before and during a noncooperative fetch',async()=>{
  const controller=new AbortController(),pending=deferred();let cancelled=0;
  const x=await fixture(undefined,undefined,{fetch:()=>pending.promise});
  const done=x.request({signal:controller.signal});controller.abort();
  assert.equal((await done).error.code,'CANCELLED');
  pending.resolve(new Response(new ReadableStream({cancel(){cancelled++;}}),{headers:{'content-type':'application/json'}}));
  await tick();await tick();assert.equal(cancelled,1);
  assert.equal((await x.request({signal:controller.signal})).error.code,'CANCELLED');assert.equal(x.fetches,1);
});

for(const phase of ['headers','body'])test(`app request checks its monotonic deadline after ${phase} even before the timer callback runs`,async()=>{
  let now=0,cancelled=0;
  const x=await fixture(undefined,undefined,{now:()=>now,fetch:()=>{
    if(phase==='headers')now=11;
    return Promise.resolve(new Response(new ReadableStream({
      pull(controller){now=11;controller.enqueue(new TextEncoder().encode('{"ok":true,"data":{}}'));controller.close();},
      cancel(){cancelled++;},
    },{highWaterMark:0}),{headers:{'content-type':'application/json'}}));
  }});
  assert.equal((await x.request({timeoutMs:10})).error.code,'TIMEOUT');
  if(phase==='headers')assert.equal(cancelled,1);
  assert.equal(x.timers.size,0);
});

for(const invalid of ['declared-size','actual-size','mime'])test(`app request rejects ${invalid} without reading unbounded JSON`,async()=>{
  let cancelled=0;
  const x=await fixture(undefined,undefined,{fetch:()=>Promise.resolve(new Response(new ReadableStream({
    start(controller){if(invalid==='actual-size')controller.enqueue(new Uint8Array(2*1024*1024+1));},cancel(){cancelled++;},
  }),{headers:{'content-type':invalid==='mime'?'text/html':'application/json',...(invalid==='declared-size'?{'content-length':String(2*1024*1024+1)}:{})}}))});
  assert.equal((await x.request()).error.code,'INVALID_RESPONSE');assert.equal(cancelled,1);assert.equal(x.timers.size,0);
});

test('app request preserves successful envelope metadata and server rejection contracts',async()=>{
  let reject=false;
  const x=await fixture(undefined,undefined,{fetch:()=>Promise.resolve(Response.json(reject
    ?{ok:false,error:{code:'FIXTURE_REJECTED',message:'Fixture rejection',retryable:true},meta:{mode:'connected',checkedAt:'fixture-time'}}
    :{ok:true,data:{value:1},coverage:{kind:'fixture'},meta:{mode:'demo',checkedAt:'fixture-time'}},{status:reject?403:200}))});
  const success=await x.request();assert.equal(success.ok,true);assert.equal(success.data.value,1);assert.equal(success.meta.mode,'demo');assert.equal(success.coverage.kind,'fixture');
  reject=true;const failure=await x.request();assert.equal(failure.ok,false);assert.equal(failure.error.code,'FIXTURE_REJECTED');assert.equal(failure.error.retryable,true);assert.equal(failure.meta.mode,'connected');
});
