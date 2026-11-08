import assert from 'node:assert/strict';
import {test} from 'node:test';
import {operationsSnapshot} from '../src/operations.mjs';

class Element extends EventTarget {
  constructor(){
    super(); this.value='all'; this.textContent=''; this.disabled=false;
    this.children=[]; this.attributes={};
    const classes=new Set();
    this.classList={add:value=>classes.add(value),remove:value=>classes.delete(value),contains:value=>classes.has(value)};
  }
  append(...items){this.children.push(...items);}
  replaceChildren(...items){this.children=[...items];}
  setAttribute(key,value){this.attributes[key]=String(value);}
  getAttribute(key){return this.attributes[key]??null;}
  scrollIntoView(){}
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
let fixtureId=0;
async function setup(t,{settle=true,networkFailure=false}={}){
  const saved=Object.fromEntries(['document','window','fetch'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  t.after(()=>{for(const [key,descriptor] of Object.entries(saved))if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];});
  const nodes=new Map();
  const node=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);};
  const doc={getElementById:node,createElement:()=>new Element(),createElementNS:()=>new Element()};
  const records=[
    {id:'deployment_manifest',outcome:'verified',httpStatus:200},
    {id:'static_redaction',outcome:'verified',httpStatus:200},
    {id:'anonymous_notes',outcome:'verified',httpStatus:401},
    {id:'anonymous_restore',outcome:'inconclusive',httpStatus:networkFailure?null:503},
    {id:'authenticated_notes',outcome:'unrun',httpStatus:null},
  ];
  const snapshot=operationsSnapshot(records,{target:'https://example.vercel.app'});
  const fetch=settle?async()=>({ok:true,json:async()=>snapshot}):()=>new Promise(()=>{});
  for(const [key,value] of Object.entries({document:doc,window:new EventTarget(),fetch}))
    Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  const {initOperations}=await import(`../public/operations.mjs?chart-test=${++fixtureId}`);
  initOperations();
  if(!settle){
    await tick();
    assert.notEqual(node('ops-target').textContent,snapshot.target);
    return {node,bars:()=>node('outcomes-chart').children.filter(el=>el.getAttribute('role')==='button')};
  }
  for(let i=0;i<100&&node('ops-target').textContent!==snapshot.target;i++)await tick();
  assert.equal(node('ops-target').textContent,snapshot.target,'fixture must finish rendering');
  const bars=()=>node('outcomes-chart').children.filter(el=>el.getAttribute('role')==='button');
  return {node,bars};
}

test('the ledger chart is visible before an API snapshot arrives',async t=>{
  const {node}=await setup(t,{settle:false});
  assert.equal(node('outcomes-chart').getAttribute('aria-label'),'HTTP 일치 0건, 불일치 0건, 보류 0건, 미실행 22건');
  assert.equal(node('evidence-body').children.length,22);
  assert.notEqual(node('metric-observed').textContent,'4');
});

test('chart totals match the 22 ledger rows rather than the five API probes',async t=>{
  const {node,bars}=await setup(t);
  assert.equal(node('evidence-body').children.length,22);
  assert.equal(node('outcomes-chart').getAttribute('aria-label'),'HTTP 일치 2건, 불일치 0건, 보류 1건, 미실행 19건');
  assert.deepEqual(bars().map(bar=>bar.getAttribute('aria-label')),[
    'HTTP 일치 2건 — 표 필터 적용','불일치 0건 — 표 필터 적용',
    '보류 1건 — 표 필터 적용','미실행 19건 — 표 필터 적용',
  ]);
  // The summary metrics continue to count the API probes, including deployment manifest.
  assert.equal(node('metric-observed').textContent,'4');
  assert.equal(node('metric-verified').textContent,'3');
});

test('choosing a chart bar clears other filters and shows exactly its ledger count',async t=>{
  const {node,bars}=await setup(t);
  node('filter-stage').value='3'; node('filter-stage').dispatchEvent(new Event('change'));
  node('filter-kind').value='forbidden'; node('filter-kind').dispatchEvent(new Event('change'));
  assert.equal(node('evidence-body').children.length,1);
  bars()[3].dispatchEvent(new Event('click'));
  assert.equal(node('filter-stage').value,'all');
  assert.equal(node('filter-kind').value,'all');
  assert.equal(node('filter-state').value,'unrun');
  assert.equal(node('evidence-body').children.length,19);
  assert.match(node('table-count').textContent,/^19 \/ 22 /);
});

test('ledger distinguishes an unavailable HTTP response from an unrun probe',async t=>{
  const {node}=await setup(t,{networkFailure:true});
  const rows=node('evidence-body').children;
  const responseCells=rows[19].children;
  const unrunCells=rows[8].children;
  assert.equal(responseCells[4].textContent,'응답 없음');
  assert.equal(responseCells[5].textContent,'판정 보류');
  assert.equal(unrunCells[4].textContent,'미실행');
  assert.equal(unrunCells[5].textContent,'미실행');
});
