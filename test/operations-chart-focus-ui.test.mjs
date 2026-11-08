import assert from 'node:assert/strict';
import {test} from 'node:test';
import {operationsSnapshot} from '../src/operations.mjs';

// A small focus-aware DOM: removing a focused descendant returns focus to the
// body, matching browser behavior. Product rendering and event listeners run.
class Element extends EventTarget {
  constructor(doc){
    super(); this.ownerDocument=doc; this.children=[]; this.parentElement=null;
    this.attributes={}; this.value='all'; this.textContent=''; this.disabled=false;
    this.nodeType=1; const classes=new Set();
    this.classList={add:value=>classes.add(value),remove:value=>classes.delete(value),contains:value=>classes.has(value)};
  }
  append(...items){for(const item of items){item.parentElement=this;this.children.push(item);}}
  replaceChildren(...items){
    if(this.children.some(item=>item.contains(this.ownerDocument.activeElement)))
      this.ownerDocument.activeElement=this.ownerDocument.body;
    for(const item of this.children)item.parentElement=null;
    this.children=[];this.append(...items);
  }
  setAttribute(key,value){this.attributes[key]=String(value);}
  getAttribute(key){return this.attributes[key]??null;}
  contains(element){return this===element||this.children.some(child=>child.contains(element));}
  matches(selector){
    if(selector==='[role="button"]'||selector==='[role=button]')return this.getAttribute('role')==='button';
    if(selector==='.bar-column')return (this.getAttribute('class')||'').split(/\s+/u).includes('bar-column');
    return false;
  }
  closest(selector){for(let item=this;item;item=item.parentElement)if(item.matches(selector))return item;return null;}
  querySelectorAll(selector){return this.children.flatMap(child=>[...(child.matches(selector)?[child]:[]),...child.querySelectorAll(selector)]);}
  querySelector(selector){return this.querySelectorAll(selector)[0]??null;}
  focus(){this.ownerDocument.activeElement=this;}
  scrollIntoView(){}
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
let fixtureId=0;
async function setup(t){
  const saved=Object.fromEntries(['document','window','fetch'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  t.after(()=>{for(const [key,descriptor] of Object.entries(saved))if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];});
  const nodes=new Map(), doc={};
  const node=id=>{if(!nodes.has(id))nodes.set(id,new Element(doc));return nodes.get(id);};
  doc.body=new Element(doc);doc.activeElement=doc.body;
  doc.getElementById=node;doc.createElement=()=>new Element(doc);doc.createElementNS=()=>new Element(doc);
  let release;
  const pending=new Promise(resolve=>{release=resolve;});
  const snapshot=operationsSnapshot([
    {id:'static_redaction',outcome:'verified',httpStatus:200},
    {id:'anonymous_restore',outcome:'inconclusive',httpStatus:null},
  ],{target:'https://example.vercel.app'});
  const fetch=()=>pending;
  for(const [key,value] of Object.entries({document:doc,window:new EventTarget(),fetch}))
    Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  const {initOperations}=await import(`../public/operations.mjs?focus-test=${++fixtureId}`);
  initOperations();
  const bars=()=>node('outcomes-chart').children.filter(el=>el.getAttribute('role')==='button');
  const finish=async()=>{
    release({ok:true,json:async()=>snapshot});
    for(let i=0;i<100&&node('ops-target').textContent!==snapshot.target;i++)await tick();
    assert.equal(node('ops-target').textContent,snapshot.target,'fixture must finish rendering');
  };
  return {node,doc,bars,finish};
}

for(const [index,label] of ['HTTP 일치','불일치','보류','미실행'].entries()){
  test(`pending observation preserves focus on the ${label} chart control`,async t=>{
    const {node,doc,bars,finish}=await setup(t);
    bars()[index].focus();
    await finish();
    assert.ok(doc.activeElement===bars()[index],'focus should remain on the same chart category');
    assert.match(doc.activeElement.getAttribute('aria-label'),new RegExp('^'+label+' '));
    const event=new Event('keydown',{cancelable:true});
    Object.defineProperty(event,'key',{value:'Enter'});
    doc.activeElement.dispatchEvent(event);
    assert.equal(node('filter-state').value,['verified','failed','inconclusive','unrun'][index]);
  });
}

test('pending observation does not move focus from an outside control',async t=>{
  const {node,doc,finish}=await setup(t);
  node('filter-stage').focus();
  await finish();
  assert.ok(doc.activeElement===node('filter-stage'),'the outside control should keep focus');
});
