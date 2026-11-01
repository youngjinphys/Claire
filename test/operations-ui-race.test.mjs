import assert from 'node:assert/strict';
import {test} from 'node:test';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const until=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await tick();}throw Error('fixture timed out');};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};

class Element extends EventTarget {
  constructor(){
    super();this.value='all';this.textContent='';this.disabled=false;this.children=[];
    const classes=new Set();
    this.classList={add:value=>classes.add(value),remove:value=>classes.delete(value),contains:value=>classes.has(value)};
  }
  append(...items){this.children.push(...items);}
  replaceChildren(...items){this.children=[...items];}
  setAttribute(){}
  scrollIntoView(){}
}

const snapshot=(target,count)=>({
  schema:'aleph.operations.snapshot.v1',target,records:[],
  summary:{httpCount:count,verified:0,failed:0,inconclusive:0,unrun:0},
  verdict:{stagesRequired:12,attackTypesRequired:41,stagesVerified:0,attackTypesVerified:0},
  policy:{rules:[]},detection:{condition:'synthetic'},revocation:{executed:false},recovery:{restoredVersion:null},
});
const response=body=>({ok:true,status:200,json:async()=>body});
let fixtureId=0;
async function setup(t){
  const saved=Object.fromEntries(['document','window','fetch'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  t.after(()=>{for(const [key,value] of Object.entries(saved))if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];});
  const nodes=new Map();
  const node=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);};
  const doc={getElementById:node,createElement:()=>new Element(),createElementNS:()=>new Element()};
  const win=new EventTarget(),requests=[];
  const fetch=(_url,options)=>{const result=deferred();requests.push({...result,options});return result.promise;};
  for(const [key,value] of Object.entries({document:doc,window:win,fetch}))Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  let token='fixture-old';
  const {initOperations}=await import(`../public/operations.mjs?ui-race=${++fixtureId}`);
  initOperations({getToken:()=>token});
  return {node,win,requests,setToken:value=>{token=value;},refresh:()=>win.dispatchEvent(new Event('aleph:session'))};
}

test('an older response cannot replace the latest observation',async t=>{
  const x=await setup(t);
  x.setToken('fixture-new');x.refresh();
  assert.equal(x.requests.length,2);
  x.requests[1].resolve(response(snapshot('NEW',2)));
  await until(()=>x.node('ops-target').textContent==='NEW');
  x.requests[0].resolve(response(snapshot('OLD',1)));
  await tick();await tick();
  assert.equal(x.node('ops-target').textContent,'NEW');
  assert.equal(x.node('metric-observed').textContent,'2');
  assert.equal(x.node('ops-refresh').disabled,false);
  assert.equal(x.requests[0].options.headers.Authorization,'Bearer fixture-old');
  assert.equal(x.requests[1].options.headers.Authorization,'Bearer fixture-new');
});

test('an older failure cannot finish or replace a newer pending request',async t=>{
  const x=await setup(t);x.refresh();
  x.requests[0].reject(Error('synthetic network failure'));
  await tick();await tick();
  assert.equal(x.node('ops-refresh').disabled,true);
  assert.equal(x.node('ops-refresh').classList.contains('loading'),true);
  assert.match(x.node('ops-state').textContent,/관측 중/);
  x.requests[1].resolve(response(snapshot('NEW',2)));
  await until(()=>x.node('ops-target').textContent==='NEW');
  assert.equal(x.node('ops-refresh').disabled,false);
  assert.equal(x.node('ops-state').classList.contains('status-failed'),false);
});

test('an older delayed response body cannot replace a newer successful request',async t=>{
  const x=await setup(t),body=deferred();
  x.requests[0].resolve({ok:true,status:200,json:()=>body.promise});
  await tick();x.refresh();
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
  x.refresh();x.requests[1].reject(Error('synthetic failure'));
  await until(()=>x.node('ops-state').classList.contains('status-failed'));
  assert.equal(x.node('ops-target').textContent,'PREVIOUS');
  assert.match(x.node('ops-state').textContent,/증거 조회 실패/);
  assert.equal(x.node('ops-refresh').disabled,false);
});

test('an older success cannot erase a newer failure',async t=>{
  const x=await setup(t);
  x.requests[0].resolve(response(snapshot('PREVIOUS',1)));
  await until(()=>x.node('ops-target').textContent==='PREVIOUS');
  x.refresh();x.refresh();
  x.requests[2].reject(Error('synthetic current failure'));
  await until(()=>x.node('ops-state').classList.contains('status-failed'));
  x.requests[1].resolve(response(snapshot('STALE',2)));await tick();await tick();
  assert.equal(x.node('ops-target').textContent,'PREVIOUS');
  assert.match(x.node('ops-state').textContent,/증거 조회 실패/);
  assert.equal(x.node('ops-refresh').disabled,false);
});
