// Execute the shipped browser entry with DOM/timer/HTTP fakes; no secret or live SDP data.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import * as model from '../public/dashboard-model.mjs';
const flush=async()=>{for(let i=0;i<25;i++)await Promise.resolve();};
class Element {
  constructor(){this.handlers=new Map();this.children=[];this.dataset={};this.value='all';this.disabled=false;this.hidden=false;this.textContent='';}
  append(...children){this.children.push(...children)}
  appendChild(child){this.append(child);return child}
  replaceChildren(...children){this.children=children}
  setAttribute(name,value){this[name]=String(value)}
  removeAttribute(name){delete this[name]}
  addEventListener(name,fn){this.handlers.set(name,fn)}
  removeEventListener(name){this.handlers.delete(name)}
  click(){if(!this.disabled)this.handlers.get('click')?.({target:this});}
  remove(){}
}
async function browser(){
  const elements=new Map();const timers=new Map();let timerId=0;
  const requests=[];const window=new Element();const document=new Element();document.body=new Element();document.hidden=false;
  document.getElementById=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id)};
  document.createElement=()=>new Element();document.createElementNS=()=>new Element();document.querySelector=()=>new Element();
  const fetch=async(path)=>{
    if(path==='/api/local-pc')return new Promise(resolve=>requests.push(resolve));
    return new Response(JSON.stringify({ok:false,error:{code:'ENGINE_NOT_CONNECTED'},meta:{mode:'disconnected',checkedAt:new Date().toISOString()}}),{status:503,headers:{'content-type':'application/json'}});
  };
  const hostModes=[];
  const hostPanel=(state,mode)=>{
    hostModes.push(mode);
    const region=new Element();
    const details=new Element();
    region.querySelector=selector=>selector==='[data-host-report-details]'?details:null;
    return region;
  };
  const context=vm.createContext({...model,hostPanel,console,document,window,fetch,AbortController,URL,Blob,Response,TextDecoder,performance,
    setTimeout:(fn,delay)=>{const id=++timerId;timers.set(id,{fn,delay,type:'timeout'});return id},clearTimeout:id=>timers.delete(id),
    setInterval:(fn,delay)=>{const id=++timerId;timers.set(id,{fn,delay,type:'interval'});return id},clearInterval:id=>timers.delete(id),
  });
  const source=(await readFile(new URL('../public/dashboard.mjs',import.meta.url),'utf8'))
    .replace(/^(?:import\s*\{[\s\S]*?\}\s*from\s*['"][^'"]+['"];\s*)+/u, '');
  vm.runInContext(source,context);await flush();
  return {get:document.getElementById,requests,window,document,timers,context,hostModes};
}
function result(){
  const now=Date.now();const iso=n=>new Date(n).toISOString();
  const m=(value,unit,source,extra={})=>({status:'ok',value,unit,source,measuredAt:iso(now),...extra});
  return new Response(JSON.stringify({ok:true,data:{schema:'claire.local-pc.v1',scope:'local-machine',checkedAt:iso(now),metrics:{
    cpu:m(30,'%','os.cpus',{measuredFrom:iso(now-400),windowMs:400}),
    memory:m(50,'%','os.totalmem/os.freemem',{usedGiB:4,totalGiB:8}),
    disk:m(20,'GiB','fs.statfs',{scope:'project-filesystem'}),
  }}}),{headers:{'content-type':'application/json'}});
}
test('one-shot/start race cannot strand busy=true',async(t)=>{
  const b=await browser();t.after(()=>b.window.handlers.get('pagehide')?.({persisted:false}));b.get('sample-once').click();
  assert.equal(b.get('start').disabled,true,'start must be disabled while a one-shot owns the request');
  b.get('start').click(); b.requests[0](result());await flush();
  assert.equal(b.get('sample-once').disabled,false);
  b.get('start').click();assert.equal(b.requests.length,2);
});
test('pagehide followed by persisted pageshow restores manual controls without auto-retry',async(t)=>{
  const b=await browser();t.after(()=>b.window.handlers.get('pagehide')?.({persisted:false}));b.get('start').click();
  b.window.handlers.get('pagehide')?.({persisted:true});
  b.window.handlers.get('pageshow')?.({persisted:true});await flush();
  assert.equal(b.get('start').disabled,false);
  assert.equal(b.requests.length,1,'restoring the page must not restart measurement automatically');
  b.get('start').click();assert.equal(b.requests.length,2);
});
test('a real point remains visible even when no two-point trend is available',async(t)=>{
  const b=await browser();t.after(()=>b.window.handlers.get('pagehide')?.({persisted:false}));b.get('sample-once').click();b.requests[0](result());await flush();
  assert.equal(b.get('chart-empty').hidden,true,'the no-data overlay must not conceal valid historical points');
});
test('cancelled old response cannot overwrite a new measurement',async(t)=>{
  const b=await browser();t.after(()=>b.window.handlers.get('pagehide')?.({persisted:false}));
  b.get('sample-once').click();b.get('stop').click();
  b.get('sample-once').click();assert.equal(b.requests.length,2);
  b.requests[1](result());await flush();
  const shown=b.get('cpu-value').textContent;
  b.requests[0](new Response('not-json',{headers:{'content-type':'application/json'}}));await flush();
  assert.equal(b.get('cpu-value').textContent,shown);
  assert.equal(b.get('sample-once').disabled,false);
});
test('partial sensor failure stops polling but preserves other measured values',async(t)=>{
  const b=await browser();t.after(()=>b.window.handlers.get('pagehide')?.({persisted:false}));
  b.get('start').click();const data=await result().json();
  data.data.metrics.disk={status:'unavailable',value:null,unit:'GiB',source:'fs.statfs',measuredAt:new Date().toISOString(),reason:'DISK_READ_TIMEOUT'};
  b.requests[0](new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}}));await flush();
  assert.equal(b.get('cpu-value').textContent,'30.0');
  assert.equal(b.get('disk-value').textContent,'확인 불가');
  assert.equal(b.get('start').disabled,false);
  assert.equal([...b.timers.values()].some(timer=>timer.type==='timeout'),false,'no automatic retry timer');
});
test('hidden tab cancels an in-flight one-shot and permits explicit recovery',async(t)=>{
  const b=await browser();t.after(()=>b.window.handlers.get('pagehide')?.({persisted:false}));
  b.get('sample-once').click();b.document.hidden=true;
  b.document.handlers.get('visibilitychange')?.();await flush();
  assert.equal(b.get('start').disabled,false);assert.equal(b.get('sample-once').disabled,false);
  assert.equal(b.requests.length,1);
  b.document.hidden=false;b.document.handlers.get('visibilitychange')?.();
  assert.equal(b.requests.length,1,'showing a tab does not restart reads');
});

test('single-source host cards display SDP mode without adding a second OS endpoint',async t=>{
  const b=await browser();t.after(()=>b.window.handlers.get('pagehide')?.({persisted:false}));
  assert.ok(b.hostModes.includes('unknown'));
  assert.ok(b.hostModes.includes('disconnected'));
  assert.match(b.get('sdp-policy-detail').textContent,/SDP 미연결/);
  assert.equal(b.get('integrated-host-root').children.length,1);
  assert.equal(b.get('host-report-content').children.length,1);
  assert.equal(b.requests.length,0,'host-panel mount must not trigger CPU or OS reads');
});
