import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import vm from 'node:vm';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const until=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await tick();}throw Error('fixture timed out');};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
const inline=html.match(/<script>\s*([\s\S]*?)<\/script>/u)[1];
const source=inline.replace("import('/device.mjs')",'loadDeviceFixture()')
  .replace("import('/operations.mjs')",'loadOperationsFixture()');
const deviceSource=(await readFile(new URL('../public/device.mjs',import.meta.url),'utf8'))
  .replace('export function initDeviceAccess','function initDeviceAccess');
const reply=(body,status=200)=>Response.json(body,{status});
const identity={accessToken:'fixture-session',user:{id:'11111111-1111-4111-8111-111111111111',email:'fixture@example.invalid'}};

class Element extends EventTarget {
  constructor(tag,doc){
    super();this.tagName=tag.toUpperCase();this.ownerDocument=doc;this.parentElement=null;
    this.children=[];this.attributes=new Map();this.textContent='';this.value='';this.hidden=false;this.disabled=false;
    const classes=new Set();this.classList={add:value=>classes.add(value),remove:value=>classes.delete(value),toggle(value,force){
      const enabled=force??!classes.has(value);if(enabled)classes.add(value);else classes.delete(value);return enabled;
    }};
  }
  append(...items){for(const item of items){item.parentElement=this;this.children.push(item);}}
  replaceChildren(...items){for(const item of this.children)item.parentElement=null;this.children=[];this.append(...items);}
  contains(item){return this===item||this.children.some(child=>child.contains(item));}
  setAttribute(name,value){this.attributes.set(name,String(value));if(name==='hidden')this.hidden=true;if(name==='disabled')this.disabled=true;}
  getAttribute(name){return this.attributes.get(name)??null;}
  removeAttribute(name){this.attributes.delete(name);if(name==='hidden')this.hidden=false;if(name==='disabled')this.disabled=false;}
  focus(){this.ownerDocument.activeElement=this;}
  click(){if(!this.disabled)this.dispatchEvent(new Event('click'));}
  getBoundingClientRect(){return {top:10,bottom:30};}
  scrollIntoView(){}
}

function pageDocument(){
  const nodes=new Map(),doc=new EventTarget();
  doc.readyState='complete';doc.hidden=false;doc.hasFocus=()=>true;
  doc.createElement=tag=>new Element(tag,doc);
  doc.querySelector=selector=>nodes.get(selector.slice(1))??null;
  doc.getElementById=id=>nodes.get(id)??null;
  // Build parent relationships and initial boolean/ARIA attributes from the
  // shipped markup. An error node's own hidden flag alone is insufficient.
  const markup=html.slice(html.indexOf('<body>'),html.indexOf('<script'));
  const stack=[],voidTags=new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
  for(const match of markup.matchAll(/<\/?([a-z][\w:-]*)\b([^>]*)>/giu)){
    const tag=match[1].toLowerCase();
    if(match[0].startsWith('</')){assert.equal(stack.at(-1)?.tagName,tag.toUpperCase());stack.pop();continue;}
    const element=doc.createElement(tag);
    for(const attr of match[2].matchAll(/([^\s=\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/gu))
      element.setAttribute(attr[1],attr[2]??attr[3]??attr[4]??'');
    if(stack.length)stack.at(-1).append(element);
    if(element.getAttribute('id'))nodes.set(element.getAttribute('id'),element);
    if(tag==='body')doc.body=element;
    if(!voidTags.has(tag)&&!match[0].endsWith('/>'))stack.push(element);
  }
  doc.activeElement=doc.body;
  const node=id=>{assert.ok(nodes.has(id),`shipped HTML must contain ${id}`);return nodes.get(id);};
  const visible=element=>{
    if(!doc.body.contains(element))return false;
    for(let current=element;current;current=current.parentElement)
      if(current.hidden||current.getAttribute('aria-hidden')==='true')return false;
    return true;
  };
  const descendants=element=>element.children.flatMap(child=>[child,...descendants(child)]);
  const loginButton=descendants(node('login-form')).find(element=>element.tagName==='BUTTON'&&element.getAttribute('type')==='submit');
  assert.ok(loginButton);assert.equal(node('device-panel').hidden,true);
  assert.equal(visible(node('device-detail')),false,'the real initial ancestor hides this guidance');
  assert.equal(node('workspace').hidden,true);assert.equal(visible(node('ops-state')),true);
  const cookies=new Map([['__Host-claire_gen','0'.repeat(32)]]);
  Object.defineProperty(doc,'cookie',{
    get:()=>[...cookies].map(([key,value])=>key+'='+value).join('; '),
    set(value){
      const [pair,...attributes]=String(value).split(';'),separator=pair.indexOf('=');
      if(separator<1)return;
      const key=pair.slice(0,separator).trim(),cookieValue=pair.slice(separator+1);
      if(attributes.some(attribute=>/^\s*Max-Age\s*=\s*0\s*$/iu.test(attribute)))cookies.delete(key);else cookies.set(key,cookieValue);
    },
  });
  return {doc,node,visible,loginButton};
}

function fixture(loads={},now=()=>0,{restored=false}={}){
  const {doc,node,visible,loginButton}=pageDocument(),timers=new Map(),win=new EventTarget();let id=0,nonce=0,tail=Promise.resolve();
  const mounted={device:0,operations:0},requests=[],modules={};let opsClicks=0;
  const stored=new Map();win.localStorage={getItem:key=>stored.get(key)??null,setItem:(key,value)=>stored.set(key,String(value)),removeItem:key=>stored.delete(key)};
  win.matchMedia=()=>({matches:false});win.confirm=()=>true;win.PublicKeyCredential=class {};
  win.SimpleWebAuthnBrowser={startAuthentication:async()=>({}),startRegistration:async()=>({})};
  const context=vm.createContext({
    document:doc,window:win,location:{protocol:'https:',hostname:'fixture.invalid',port:''},
    navigator:{locks:{request(_name,options,callback){
      const pending=tail.then(()=>{if(options.signal?.aborted)throw new DOMException('aborted','AbortError');return callback({});});
      tail=pending.catch(()=>{});return pending;
    }}},
    crypto:{getRandomValues:bytes=>{bytes.fill(++nonce);return bytes;}},performance:{now},
    Response,Headers,Event,EventTarget,AbortController,DOMException,TextDecoder,
    async fetch(path){
      requests.push(path);
      if(path==='/api/auth/session')return restored?reply(identity):reply({error:'NO_SESSION'},401);
      if(path==='/api/auth/login')return reply(identity);
      if(path==='/api/auth/logout')return reply({ok:true});
      if(path==='/api/notes')return reply([]);
      if(path==='/api/device?action=status')return reply({schema:'aleph.device.status.v1',registration:'approved',verified:false,canOpenVault:false,installIsApproval:false});
      if(path==='/api/device?action=assertion-options')return reply({});
      if(path==='/api/device?action=assertion-verify')return reply({schema:'aleph.device.proof.v1',approved:true,proof:'P'.repeat(43),expiresInSeconds:120});
      throw Error('unexpected fixture request');
    },
    loadDeviceFixture:()=>loads.device?.()??Promise.resolve(modules.device),
    loadOperationsFixture:()=>loads.operations?.()??Promise.resolve(modules.operations),
    setTimeout(fn,delay){const timer=++id;timers.set(timer,{fn,delay});return timer;},clearTimeout:timer=>timers.delete(timer),
    requestAnimationFrame:()=>0,
  });
  const initDevice=vm.runInContext(deviceSource+'\ninitDeviceAccess;',context);
  modules.device={initDeviceAccess(options){mounted.device++;return initDevice(options);}};
  modules.operations={initOperations(){mounted.operations++;node('ops-refresh').addEventListener('click',()=>{opsClicks++;});}};
  vm.runInContext(source,context);
  return {context,node,visible,loginButton,win,timers,mounted,modules,requests,get opsClicks(){return opsClicks;},
    fireDeadline(){const timer=[...timers.values()].find(timer=>timer.delay===10000);assert.ok(timer);timer.fn();},
    async login(){node('email').value='fixture@example.invalid';node('password').value='fixture-only';
      node('login-form').dispatchEvent(new Event('submit',{cancelable:true}));await until(()=>visible(node('signed-in')));await tick();},
    async logout(){node('logout').click();await until(()=>visible(node('signed-out')));await tick();await tick();},
  };
}

function assertFailureVisible(x,target){
  const state=target==='device'?x.node('device-detail'):x.node('ops-state');
  assert.match(state.textContent,/불러오지 못했습니다.*브라우저 새로고침/u);assert.doesNotMatch(state.textContent,/PRIVATE_/u);
  assert.equal(x.visible(state),true,'recovery guidance must have no hidden ancestor');
  const live=x.node(target==='device'?'device-state':'ops-state');
  assert.equal(x.visible(live),true);assert.equal(live.getAttribute('role'),'status');assert.equal(live.getAttribute('aria-live'),'polite');
  for(const id of target==='device'?['device-enroll','device-unlock','device-refresh']:['ops-refresh'])assert.equal(x.node(id).disabled,true);
  assert.equal(x.visible(x.node('workspace')),false);assert.equal(x.requests.includes('/api/notes'),false);
  if(target==='device')assert.equal(x.requests.some(path=>path.startsWith('/api/device')),false);
}

for(const target of ['device','operations'])for(const outcome of ['rejected','stalled','pagehide'])
test(`${target} module ${outcome} exposes recovery before and after later login without late initialization`,async()=>{
  const pending=deferred();
  const x=fixture({[target]:()=>outcome==='rejected'?Promise.reject(Error('PRIVATE_MODULE_FAILURE')):pending.promise});
  await tick();await tick();
  if(outcome==='stalled')x.fireDeadline();
  if(outcome==='pagehide'){x.win.dispatchEvent(new Event('pagehide'));x.win.dispatchEvent(new Event('pageshow'));}
  await tick();await tick();assertFailureVisible(x,target);
  assert.equal(x.visible(x.loginButton),true);assert.equal(x.loginButton.disabled,false);
  assert.equal(x.mounted[target],0);assert.equal(x.mounted[target==='device'?'operations':'device'],1);
  if(target==='device'){x.node('ops-refresh').click();assert.equal(x.opsClicks,1);}
  await x.login();assertFailureVisible(x,target);
  pending.resolve(x.modules[target]);await tick();await tick();assert.equal(x.mounted[target],0);
  await x.logout();assertFailureVisible(x,target);assert.equal(x.timers.size,0);
});

for(const outcome of ['rejected','stalled'])test(`device module ${outcome} exposes recovery when session restoration completed first`,async()=>{
  const pending=deferred(),x=fixture({device:()=>pending.promise},()=>0,{restored:true});
  await until(()=>x.visible(x.node('signed-in')));assert.equal(x.visible(x.node('device-detail')),false);
  if(outcome==='rejected')pending.reject(Error('PRIVATE_MODULE_FAILURE'));else x.fireDeadline();
  await tick();await tick();assertFailureVisible(x,'device');
  x.node('ops-refresh').click();assert.equal(x.opsClicks,1);
  if(outcome==='stalled'){pending.resolve(x.modules.device);await tick();await tick();}
  assert.equal(x.mounted.device,0);assert.equal(x.timers.size,0);
});

test('root module loading checks a monotonic deadline before mounting even if the timer is delayed',async()=>{
  let now=0,mounted=0;
  const x=fixture({device:()=>{now=10001;return Promise.resolve({initDeviceAccess(){mounted++;}});}},()=>now);
  await tick();await tick();assert.equal(mounted,0);assertFailureVisible(x,'device');
  assert.equal(x.mounted.operations,1);assert.equal(x.timers.size,0);
});

test('timely root modules keep normal hidden state and require the shipped device verification path to open the vault',async()=>{
  const x=fixture();await tick();await tick();
  assert.deepEqual(x.mounted,{device:1,operations:1});assert.equal(x.visible(x.node('device-panel')),false);
  await x.login();await until(()=>x.node('device-state').textContent==='등록 기기 · 재인증 필요');
  assert.equal(x.visible(x.node('device-panel')),true);assert.equal(x.node('device-unlock').disabled,false);
  assert.equal(x.visible(x.node('workspace')),false);assert.equal(x.requests.includes('/api/notes'),false);
  x.node('device-unlock').click();await until(()=>x.visible(x.node('workspace'))&&x.requests.includes('/api/notes'));
  assert.equal(x.node('device-state').textContent,'인증기 확인 완료');
  await x.logout();assert.equal(x.visible(x.node('workspace')),false);assert.equal(x.visible(x.node('device-panel')),false);
  assert.deepEqual(x.mounted,{device:1,operations:1});assert.equal(x.timers.size,0);
});
