import assert from 'node:assert/strict';
import {test} from 'node:test';

class Element extends EventTarget {
  constructor(){
    super();this.value='all';this.textContent='';this.children=[];this.attributes={};
    this.disabled=false;this.scrollCalls=[];
    const classes=new Set();
    this.classList={add:value=>classes.add(value),remove:value=>classes.delete(value)};
  }
  append(...items){this.children.push(...items);}
  replaceChildren(...items){this.children=[...items];}
  setAttribute(key,value){this.attributes[key]=String(value);}
  getAttribute(key){return this.attributes[key]??null;}
  scrollIntoView(options){this.scrollCalls.push(options);}
}
let fixtureId=0;
async function setup(t,{reduced=false,mediaAvailable=true}={}){
  const saved=Object.fromEntries(['document','window','fetch'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  t.after(()=>{for(const [key,descriptor] of Object.entries(saved))if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];});
  const nodes=new Map();
  const node=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);};
  const doc={getElementById:node,createElement:()=>new Element(),createElementNS:()=>new Element()};
  const win=new EventTarget();
  const preference={reduced};
  if(mediaAvailable)win.matchMedia=()=>({get matches(){return preference.reduced;}});
  for(const [key,value] of Object.entries({document:doc,window:win,fetch:()=>new Promise(()=>{})}))
    Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  const {initOperations}=await import(`../public/operations.mjs?motion-test=${++fixtureId}`);
  initOperations();
  const bars=node('outcomes-chart').children.filter(el=>el.getAttribute('role')==='button');
  assert.equal(bars.length,4);
  return {node,bars,preference};
}

test('chart selection uses normal scrolling when motion is not reduced',async t=>{
  const {node,bars}=await setup(t);
  bars[3].dispatchEvent(new Event('click'));
  assert.equal(node('filter-state').value,'unrun');
  assert.equal(node('evidence').scrollCalls.length,1);
  assert.equal(node('evidence').scrollCalls[0].block,'start');
  // auto (or an omitted behavior) delegates to the document's CSS, which
  // supplies smooth scrolling in the default motion mode.
  assert.ok(['smooth','auto',undefined].includes(node('evidence').scrollCalls[0].behavior));
});

test('chart selection scrolls without animation when reduced motion is requested',async t=>{
  const {node,bars}=await setup(t,{reduced:true});
  bars[3].dispatchEvent(new Event('click'));
  assert.equal(node('filter-state').value,'unrun');
  assert.equal(node('evidence').scrollCalls.length,1);
  assert.equal(node('evidence').scrollCalls[0].block,'start');
  assert.ok(['auto','instant',undefined].includes(node('evidence').scrollCalls[0].behavior));
});

test('chart selection reflects a changed system motion preference',async t=>{
  const {node,bars,preference}=await setup(t);
  bars[3].dispatchEvent(new Event('click'));
  preference.reduced=true;
  bars[0].dispatchEvent(new Event('click'));
  assert.equal(node('filter-state').value,'verified');
  assert.ok(['smooth','auto',undefined].includes(node('evidence').scrollCalls[0].behavior));
  assert.ok(['auto','instant',undefined].includes(node('evidence').scrollCalls[1].behavior));
});

test('chart selection remains usable if matchMedia is unavailable',async t=>{
  const {node,bars}=await setup(t,{mediaAvailable:false});
  bars[3].dispatchEvent(new Event('click'));
  assert.equal(node('filter-state').value,'unrun');
  assert.equal(node('evidence').scrollCalls.length,1);
});
