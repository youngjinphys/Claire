import assert from 'node:assert/strict';
import {test} from 'node:test';
import {operationsSnapshot,PROBES} from '../src/operations.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const until=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await tick();}throw Error('fixture timed out');};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};

class Element extends EventTarget {
  constructor(){
    super();this.value='all';this.textContent='';this.disabled=false;this.children=[];
    this.attributes=new Map();
    const classes=new Set();
    this.classList={add:value=>classes.add(value),remove:value=>classes.delete(value),contains:value=>classes.has(value)};
  }
  append(...items){for(const item of items){item.parent=this;this.children.push(item);}}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(item=>item!==this);}
  click(){this.dispatchEvent(new Event('click'));}
  replaceChildren(...items){this.children=[...items];}
  setAttribute(key,value){this.attributes.set(key,String(value));}
  getAttribute(key){return this.attributes.get(key)??null;}
  focus(){document.activeElement=this;}
  scrollIntoView(){}
}

// Raw EventTarget below exercises registration order. This alternate model
// also exercises capture-first ordering and native-style microtask checkpoints
// between lifecycle listeners; neither order is assumed by the product.
class LifecycleWindow extends EventTarget {
  listeners=new Map();
  constructor(captureFirst){super();this.captureFirst=captureFirst;}
  addEventListener(type,callback,options){
    if(['pagehide','pageshow'].includes(type)){
      if(!this.listeners.has(type))this.listeners.set(type,[]);
      this.listeners.get(type).push({callback,capture:options===true||options?.capture===true});return;
    }
    super.addEventListener(type,callback,options);
  }
  removeEventListener(type,callback,options){
    if(['pagehide','pageshow'].includes(type)){
      const capture=options===true||options?.capture===true;
      this.listeners.set(type,(this.listeners.get(type)||[]).filter(item=>item.callback!==callback||item.capture!==capture));
    }else super.removeEventListener(type,callback,options);
  }
  ordered(type){
    const listeners=[...(this.listeners.get(type)||[])];
    return this.captureFirst?listeners.sort((a,b)=>Number(b.capture)-Number(a.capture)):listeners;
  }
  dispatchEvent(event){
    if(['pagehide','pageshow'].includes(event.type)){
      for(const {callback} of this.ordered(event.type))callback.call(this,event);
      return true;
    }
    return super.dispatchEvent(event);
  }
  async dispatchWithCheckpoints(event){
    for(const {callback} of this.ordered(event.type)){
      callback.call(this,event);
      // Allow listener-scheduled microtasks to run before the next listener.
      await Promise.resolve();await Promise.resolve();
    }
  }
}

const snapshot=(target,count)=>({
  ...operationsSnapshot(PROBES.slice(0,count).map(({id})=>({id,outcome:'verified',httpStatus:200}))),
  target,
});
const response=body=>Response.json(body);
let fixtureId=0;
async function setup(t,options={}){
  const realSetTimeout=globalThis.setTimeout;
  const saved=Object.fromEntries(['document','window','fetch','setTimeout','clearTimeout'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  t.after(()=>{for(const [key,value] of Object.entries(saved))if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];});
  const timers=new Set();
  if(options.manualTimers){
    globalThis.setTimeout=(fn,delay)=>{const timer={fn,delay};timers.add(timer);return timer;};
    globalThis.clearTimeout=timer=>timers.delete(timer);
  }
  const nodes=new Map();
  const node=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);};
  const doc={body:new Element(),getElementById:node,createElement:()=>new Element(),createElementNS:()=>new Element()};
  doc.activeElement=doc.body;
  const win=options.captureFirst||options.checkpoints?new LifecycleWindow(options.captureFirst):new EventTarget(),requests=[];
  const fetch=(_url,options)=>{const result=deferred();requests.push({...result,options});return result.promise;};
  for(const [key,value] of Object.entries({document:doc,window:win,fetch}))Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  let token='fixture-old';
  options.beforeInit?.(win,node);
  const {initOperations}=await import(`../public/operations.mjs?ui-race=${++fixtureId}`);
  initOperations({getToken:()=>token,...options});
  return {node,win,doc,requests,async runTasks(){
    if(options.manualTimers){
      for(const timer of [...timers])if(timer.delay===0&&timers.delete(timer))timer.fn();
    }else await new Promise(resolve=>realSetTimeout(resolve,0));
    await tick();
  },pendingTasks:()=>[...timers].filter(timer=>timer.delay===0).length,
  lifecycle:type=>options.checkpoints?win.dispatchWithCheckpoints(new Event(type)):win.dispatchEvent(new Event(type)),fireHttpTimeout(){
    const timer=[...timers].find(timer=>timer.delay===(options.requestTimeoutMs??12000));assert.ok(timer);
    timers.delete(timer);timer.fn();
  },setToken:value=>{token=value;},refresh:()=>win.dispatchEvent(new Event('aleph:session'))};
}

const lifecycleModels=[
  {name:'registration order'},
  {name:'capture-first',captureFirst:true},
  {name:'registration order with listener checkpoints',checkpoints:true},
  {name:'capture-first with listener checkpoints',captureFirst:true,checkpoints:true},
];
for(const model of lifecycleModels)for(const order of ['before','after'])test(`${model.name}: pagehide blocks a ${order}-registered device lock refresh`,async t=>{
  const notify=(win,node)=>win.addEventListener('pagehide',()=>{
    win.dispatchEvent(new Event('aleph:session'));node('ops-refresh').click();
  });
  const x=await setup(t,{manualTimers:true,...model,...(order==='before'?{beforeInit:notify}:{})});
  if(order==='after')notify(x.win,x.node);
  assert.equal(x.requests.length,1);
  x.node('filter-stage').focus();await x.lifecycle('pagehide');
  assert.equal(x.requests.length,1,'no listener may dispatch while pagehide is in progress');
  assert.equal(x.requests[0].options.signal.aborted,true);
  await tick();x.refresh();x.node('ops-refresh').click();await x.runTasks();
  assert.equal(x.requests.length,1,'later hidden-page callbacks cannot restart a read');
  assert.equal(x.pendingTasks(),0,'pagehide cancels queued event-driven work');
  assert.equal(x.node('ops-refresh').getAttribute('aria-disabled'),'true');
  assert.equal(x.node('ops-state').classList.contains('status-failed'),false);
  assert.match(x.node('ops-state').textContent,/관측 일시 중지/u);
  assert.equal(x.doc.activeElement,x.node('filter-stage'));
  let cancelled=0;
  x.requests[0].resolve(new Response(new ReadableStream({cancel(){cancelled++;return new Promise(()=>{});}}),{headers:{'content-type':'application/json'}}));
  await until(()=>cancelled===1);
  assert.doesNotMatch(x.node('ops-state').textContent,/조회 실패/u);
});

for(const model of lifecycleModels)test(`${model.name}: pageshow coalesces into one task using the final identity`,async t=>{
  let x;
  x=await setup(t,{manualTimers:true,...model,beforeInit(win,node){win.addEventListener('pageshow',()=>{
    x.setToken('fixture-early-return');win.dispatchEvent(new Event('aleph:session'));node('ops-refresh').click();
  });}});
  x.win.addEventListener('pageshow',()=>{
    x.setToken('fixture-latest-return');x.refresh();x.node('ops-refresh').click();
  });
  await x.lifecycle('pagehide');
  await x.lifecycle('pageshow');await x.lifecycle('pageshow');
  assert.equal(x.requests.length,1,'resume waits for synchronous lifecycle callbacks');
  assert.equal(x.pendingTasks(),1);
  await x.runTasks();
  await until(()=>x.requests.length===2);
  assert.equal(x.requests[1].options.headers.Authorization,'Bearer fixture-latest-return');
  assert.equal(x.requests[1].options.signal.aborted,false);
  x.requests[1].resolve(response(snapshot('RETURNED',2)));
  await until(()=>x.node('ops-target').textContent==='RETURNED');
  assert.equal(x.node('ops-refresh').getAttribute('aria-disabled'),'false');
  assert.equal(x.node('ops-state').classList.contains('status-failed'),false);
  x.requests[0].resolve(response(snapshot('HIDDEN_OLD',1)));await tick();await tick();
  assert.equal(x.node('ops-target').textContent,'RETURNED');assert.equal(x.requests.length,2);
});

test('page suspension preserves the snapshot and focus while cancelling its pending body',async t=>{
  const x=await setup(t,{manualTimers:true});
  x.requests[0].resolve(response(snapshot('PREVIOUS',1)));await until(()=>x.node('ops-target').textContent==='PREVIOUS');
  const chartNodes=x.node('outcomes-chart').children,rows=x.node('evidence-body').children;
  const focus=chartNodes.find(node=>node.getAttribute('role')==='button');assert.ok(focus);focus.focus();
  x.refresh();await x.runTasks();let cancelled=0;
  const pending=new Response(new ReadableStream({cancel(){cancelled++;return new Promise(()=>{});}}),{headers:{'content-type':'application/json'}});
  x.requests[1].resolve(pending);await until(()=>pending.body.locked);
  x.win.dispatchEvent(new Event('pagehide'));await until(()=>cancelled===1);
  assert.equal(pending.body.locked,false);
  assert.equal(x.node('ops-target').textContent,'PREVIOUS');assert.equal(x.node('metric-observed').textContent,'1');
  assert.equal(x.node('evidence-body').children,rows);assert.equal(x.node('outcomes-chart').children,chartNodes);
  assert.equal(x.node('ops-export').disabled,false);assert.equal(x.doc.activeElement,focus);
  assert.match(x.node('ops-state').textContent,/관측 일시 중지.*마지막으로 받은 기록/u);
  x.win.dispatchEvent(new Event('pageshow'));await x.runTasks();await until(()=>x.requests.length===3);
  x.requests[2].resolve(response(snapshot('RESUMED',2)));await until(()=>x.node('ops-target').textContent==='RESUMED');
  assert.equal(x.doc.activeElement,focus);assert.equal(x.node('outcomes-chart').children,chartNodes);
  assert.equal(x.node('ops-state').classList.contains('status-failed'),false);
});

test('a second pagehide invalidates a queued resume and pageshow without suspension does not refresh',async t=>{
  const x=await setup(t,{manualTimers:true});
  x.win.dispatchEvent(new Event('pageshow'));await x.runTasks();assert.equal(x.requests.length,1);
  x.win.dispatchEvent(new Event('pagehide'));x.win.dispatchEvent(new Event('pageshow'));x.win.dispatchEvent(new Event('pagehide'));
  await x.runTasks();assert.equal(x.requests.length,1);assert.equal(x.pendingTasks(),0);assert.equal(x.node('ops-refresh').getAttribute('aria-disabled'),'true');
  x.win.dispatchEvent(new Event('pageshow'));await x.runTasks();await until(()=>x.requests.length===2);
  x.requests[1].resolve(response(snapshot('RESUMED_ONCE',1)));await until(()=>x.node('ops-target').textContent==='RESUMED_ONCE');
  x.win.dispatchEvent(new Event('pageshow'));await x.runTasks();assert.equal(x.requests.length,2);
  x.requests[0].reject(Error('old hidden read'));await tick();
  assert.equal(x.node('ops-state').classList.contains('status-failed'),false);
});

test('an idle published observation sends no request during or after registration-order pagehide',async t=>{
  const x=await setup(t,{manualTimers:true,beforeInit(win){win.addEventListener('pagehide',()=>win.dispatchEvent(new Event('aleph:session')));}});
  x.requests[0].resolve(response(snapshot('IDLE',2)));await until(()=>x.node('ops-target').textContent==='IDLE');
  const before={started:x.requests.length,active:x.requests.filter(request=>!request.options.signal.aborted).length,
    target:x.node('ops-target').textContent,observed:x.node('metric-observed').textContent};
  x.win.dispatchEvent(new Event('pagehide'));x.refresh();x.node('ops-refresh').click();
  await x.runTasks();
  assert.deepEqual({started:x.requests.length,active:x.requests.filter(request=>!request.options.signal.aborted).length,
    target:x.node('ops-target').textContent,observed:x.node('metric-observed').textContent},before);
  assert.equal(x.pendingTasks(),0);assert.equal(x.node('ops-state').classList.contains('status-failed'),false);
});

test('a visible refresh burst invalidates old publication immediately and sends one task with the latest identity',async t=>{
  const x=await setup(t,{manualTimers:true});
  x.setToken('fixture-intermediate');x.refresh();x.setToken('fixture-final');x.refresh();x.node('ops-refresh').click();
  assert.equal(x.requests.length,1);assert.equal(x.requests[0].options.signal.aborted,true);assert.equal(x.pendingTasks(),1);
  x.requests[0].resolve(response(snapshot('STALE',1)));await tick();await tick();
  assert.notEqual(x.node('ops-target').textContent,'STALE');
  await x.runTasks();assert.equal(x.requests.length,2);assert.equal(x.requests[1].options.headers.Authorization,'Bearer fixture-final');
  x.requests[1].resolve(response(snapshot('CURRENT',2)));await until(()=>x.node('ops-target').textContent==='CURRENT');
  assert.equal(x.node('ops-refresh').getAttribute('aria-disabled'),'false');assert.equal(x.pendingTasks(),0);
});

test('a successful operations response releases its acquired reader lock',async t=>{
  const x=await setup(t),received=response(snapshot('RELEASED',1));
  x.requests[0].resolve(received);await until(()=>x.node('ops-target').textContent==='RELEASED');
  assert.equal(received.body.locked,false);
});

test('operations deadline releases a pending reader without waiting for cancellation',async t=>{
  const x=await setup(t,{manualTimers:true});let cancelled=0;
  const received=new Response(new ReadableStream({cancel(){cancelled++;return new Promise(()=>{});}}),{headers:{'content-type':'application/json'}});
  x.requests[0].resolve(received);await until(()=>received.body.locked);x.fireHttpTimeout();
  await until(()=>x.node('ops-refresh').getAttribute('aria-disabled')==='false');
  assert.equal(cancelled,1);assert.equal(received.body.locked,false);
});

test('an older response cannot replace the latest observation',async t=>{
  const x=await setup(t);
  x.setToken('fixture-new');x.refresh();await x.runTasks();
  assert.equal(x.requests.length,2);
  x.requests[1].resolve(response(snapshot('NEW',2)));
  await until(()=>x.node('ops-target').textContent==='NEW');
  x.requests[0].resolve(response(snapshot('OLD',1)));
  await tick();await tick();
  assert.equal(x.node('ops-target').textContent,'NEW');
  assert.equal(x.node('metric-observed').textContent,'2');
  assert.equal(x.node('ops-refresh').getAttribute('aria-disabled'),'false');
  assert.equal(x.requests[0].options.headers.Authorization,'Bearer fixture-old');
  assert.equal(x.requests[1].options.headers.Authorization,'Bearer fixture-new');
});

test('an older failure cannot finish or replace a newer pending request',async t=>{
  const x=await setup(t);x.refresh();await x.runTasks();
  x.requests[0].reject(Error('synthetic network failure'));
  await tick();await tick();
  assert.equal(x.node('ops-refresh').getAttribute('aria-disabled'),'true');
  assert.match(x.node('ops-state').textContent,/관측 중/);
  x.requests[1].resolve(response(snapshot('NEW',2)));
  await until(()=>x.node('ops-target').textContent==='NEW');
  assert.equal(x.node('ops-refresh').getAttribute('aria-disabled'),'false');
  assert.equal(x.node('ops-state').classList.contains('status-failed'),false);
});

test('an older delayed response body cannot replace a newer successful request',async t=>{
  const x=await setup(t),body=deferred();
  let cancelled=false;
  x.requests[0].resolve(new Response(new ReadableStream({start(controller){body.promise.then(value=>{if(cancelled)return;controller.enqueue(new TextEncoder().encode(JSON.stringify(value)));controller.close();});},cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}}));
  await tick();x.refresh();await x.runTasks();
  x.requests[1].resolve(response(snapshot('NEW',2)));
  await until(()=>x.node('ops-target').textContent==='NEW');
  body.resolve(snapshot('OLD',1));await tick();await tick();
  assert.equal(x.node('ops-target').textContent,'NEW');
  assert.equal(x.node('metric-observed').textContent,'2');
});

test('the latest failure remains visible and retains the previous observation',async t=>{
  const x=await setup(t);
  x.requests[0].resolve(response(snapshot('PREVIOUS',1)));
  await until(()=>x.node('ops-target').textContent==='PREVIOUS');
  x.refresh();await x.runTasks();x.requests[1].reject(Error('synthetic failure'));
  await until(()=>x.node('ops-state').classList.contains('status-failed'));
  assert.equal(x.node('ops-target').textContent,'PREVIOUS');
  assert.match(x.node('ops-state').textContent,/증적 조회 실패/);
  assert.equal(x.node('ops-refresh').getAttribute('aria-disabled'),'false');
});

test('record list distinguishes an empty result from an observation without an HTTP status',async t=>{
  const x=await setup(t);
  const list=x.node('ops-records');
  const observation=operationsSnapshot([{id:PROBES[0].id,outcome:'inconclusive'}]);
  delete observation.records[0].httpStatus;
  x.requests[0].resolve(response(observation));
  await until(()=>list.children.length===1);
  const line=list.children[0].children[0];
  assert.deepEqual(line.children.map(child=>child.textContent),[
    PROBES[0].method+' '+PROBES[0].path,'판정 보류',
  ]);

  x.refresh();await x.runTasks();
  x.requests[1].resolve(response(snapshot('EMPTY',0)));
  await until(()=>x.node('ops-target').textContent==='EMPTY');
  assert.deepEqual(list.children.map(child=>child.textContent),['이번 조회에서 받은 서버 기록이 없습니다.']);
});

test('an older success cannot erase a newer failure',async t=>{
  const x=await setup(t);
  x.requests[0].resolve(response(snapshot('PREVIOUS',1)));
  await until(()=>x.node('ops-target').textContent==='PREVIOUS');
  x.refresh();await x.runTasks();x.refresh();await x.runTasks();
  x.requests[2].reject(Error('synthetic current failure'));
  await until(()=>x.node('ops-state').classList.contains('status-failed'));
  x.requests[1].resolve(response(snapshot('STALE',2)));await tick();await tick();
  assert.equal(x.node('ops-target').textContent,'PREVIOUS');
  assert.match(x.node('ops-state').textContent,/증적 조회 실패/);
  assert.equal(x.node('ops-refresh').getAttribute('aria-disabled'),'false');
});

test('an initial failure leaves export disabled and the refresh action can retry once',async t=>{
  const x=await setup(t);
  // The real button is initially disabled in the document.
  x.node('ops-export').disabled=true;
  x.requests[0].reject(Error('synthetic initial failure'));
  await until(()=>x.node('ops-state').classList.contains('status-failed'));
  assert.equal(x.node('ops-export').disabled,true);
  assert.equal(x.node('ops-info').textContent,'받은 HTTP 기록 없음');
  const refresh=x.node('ops-refresh');
  refresh.dispatchEvent(new Event('click'));
  refresh.dispatchEvent(new Event('click'));
  await x.runTasks();
  assert.equal(x.requests.length,2);
  x.requests[1].resolve(response(snapshot('RECOVERED',1)));
  await until(()=>x.node('ops-target').textContent==='RECOVERED');
  assert.equal(x.node('ops-export').disabled,false);
  assert.equal(refresh.getAttribute('aria-disabled'),'false');
});

for(const failure of ['url','click'])test(`operations export ${failure} failure preserves evidence and cleans up the download anchor`,async t=>{
  const x=await setup(t);
  x.requests[0].resolve(response(snapshot('EXPORT',2)));
  await until(()=>x.node('ops-target').textContent==='EXPORT');
  const created=[],revoked=[],timers=[];
  t.mock.method(URL,'createObjectURL',()=>{if(failure==='url')throw Error('private blocked download');created.push('blob:fixture-export');return created.at(-1);});
  t.mock.method(URL,'revokeObjectURL',url=>revoked.push(url));
  t.mock.method(globalThis,'setTimeout',(fn,delay)=>{timers.push({fn,delay});return 1;});
  const make=x.doc.createElement;
  x.doc.createElement=tag=>{const el=make(tag);if(tag==='a'&&failure==='click')el.click=()=>{throw Error('private click failure');};return el;};
  x.node('ops-export').dispatchEvent(new Event('click'));
  assert.match(x.node('ops-state').textContent,/JSON 저장 확인 불가/u);
  assert.doesNotMatch(x.node('ops-state').textContent,/private/u);
  assert.equal(x.doc.body.children.length,0);
  assert.equal(x.node('ops-target').textContent,'EXPORT');
  assert.equal(x.node('ops-export').disabled,false);
  assert.equal(x.node('metric-observed').textContent,'2');
  assert.equal(revoked.length,0);
  if(failure==='click'){
    assert.equal(timers.length,1);assert.equal(timers[0].delay,5000);
    timers[0].fn();assert.deepEqual(revoked,created);
  }else assert.equal(timers.length,0);
});

test('operations export reports a download request and releases its object URL after the click',async t=>{
  const x=await setup(t);
  x.requests[0].resolve(response(snapshot('EXPORT',2)));
  await until(()=>x.node('ops-target').textContent==='EXPORT');
  let revoked=false,cleanup,clicked=false;
  t.mock.method(URL,'createObjectURL',()=> 'blob:fixture-export');
  t.mock.method(URL,'revokeObjectURL',()=>{revoked=true;});
  t.mock.method(globalThis,'setTimeout',fn=>{cleanup=fn;return 1;});
  const make=x.doc.createElement;
  x.doc.createElement=tag=>{const el=make(tag);if(tag==='a')el.click=()=>{assert.equal(revoked,false);assert.ok(x.doc.body.children.includes(el));clicked=true;};return el;};
  x.node('ops-export').dispatchEvent(new Event('click'));
  assert.equal(clicked,true);
  assert.equal(x.doc.body.children.length,0);
  assert.match(x.node('ops-state').textContent,/저장을 요청했습니다/u);
  assert.doesNotMatch(x.node('ops-state').textContent,/저장 완료/u);
  assert.equal(revoked,false);cleanup();assert.equal(revoked,true);
});

test('operations headers timeout restores the retry control and cancels a late response body',async t=>{
  let cancelled=0;
  const x=await setup(t,{manualTimers:true});
  x.fireHttpTimeout();await until(()=>x.node('ops-refresh').getAttribute('aria-disabled')==='false');
  assert.equal(x.requests[0].options.signal.aborted,true);
  assert.equal(x.node('ops-refresh').getAttribute('aria-disabled'),'false');
  assert.match(x.node('ops-state').textContent,/조회 실패/u);
  x.requests[0].resolve(new Response(new ReadableStream({cancel(){cancelled++;}}),{headers:{'content-type':'application/json'}}));
  await tick();await tick();
  assert.equal(cancelled,1);
  assert.notEqual(x.node('ops-target').textContent,'LATE');
});

test('operations stalled body has a bounded lifetime and retains the last observation',async t=>{
  let cancelled=0;
  const x=await setup(t,{manualTimers:true});
  x.requests[0].resolve(response(snapshot('PREVIOUS',1)));
  await until(()=>x.node('ops-target').textContent==='PREVIOUS');
  x.refresh();await x.runTasks();
  x.requests[1].resolve(new Response(new ReadableStream({cancel(){cancelled++;}}),{headers:{'content-type':'application/json'}}));
  await tick();x.fireHttpTimeout();await until(()=>x.node('ops-refresh').getAttribute('aria-disabled')==='false');
  assert.equal(cancelled,1);
  assert.equal(x.node('ops-target').textContent,'PREVIOUS');
  assert.equal(x.node('ops-export').disabled,false);
  assert.equal(x.node('ops-refresh').getAttribute('aria-disabled'),'false');
  assert.match(x.node('ops-state').textContent,/마지막으로 받은 기록/u);
});

test('operations rejection disposes an unread body without waiting for its cancellation promise',async t=>{
  let cancelled=0;
  const x=await setup(t);
  x.requests[0].resolve(new Response(new ReadableStream({cancel(){cancelled++;return new Promise(()=>{});}}),{status:503}));
  await until(()=>x.node('ops-refresh').getAttribute('aria-disabled')==='false');
  assert.equal(cancelled,1);
  assert.match(x.node('ops-state').textContent,/HTTP_503/u);
});
