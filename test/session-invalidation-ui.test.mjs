import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createContext,Script} from 'node:vm';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(predicate){for(let i=0;i<100;i++){if(predicate())return;await tick();}throw Error('timed out waiting for UI state');}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const proof={schema:'aleph.device.proof.v1',approved:true,proof:'fixture-proof',expiresInSeconds:120};
const approved={registration:'approved',verified:false,canOpenVault:false};
const ownerA='11111111-1111-4111-8111-111111111111';
const ownerB='22222222-2222-4222-8222-222222222222';
class Element extends EventTarget{
  constructor(tag=''){super();this.tagName=tag.toUpperCase();this.hidden=false;this.disabled=false;this.textContent='';this.value='';this.children=[];this.attributes=new Map();this.classList={toggle(){},add(){},remove(){}};}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this.children=[...children];}
  setAttribute(name,value){this.attributes.set(name,String(value));}
  getAttribute(name){return this.attributes.get(name)??null;}
  removeAttribute(name){this.attributes.delete(name);}
  focus(){if(globalThis.document)globalThis.document.activeElement=this;}
  getBoundingClientRect(){return {top:10,bottom:30};}
}
async function setup(t,{refreshFailure='http',delayRefresh=false,delayBootstrap=false,delayLogout=false,delayLogin=false,delayNotesRead=false,notesFailure=null,initialId,refreshId,loginId,emptyNotes=false,persistBeforePostResponse=false,initialNotes=null,captureMutationTimers=false,cryptoOverride}={}){
  const keys=['window','document','navigator','location','BroadcastChannel','fetch','setTimeout','clearTimeout','requestAnimationFrame','crypto'];
  const saved=Object.fromEntries(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  t.after(()=>{for(const [key,value] of Object.entries(saved))if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];});
  const ids=['signed-out','signed-in','workspace','vault-title','login-form','logout','login-status','workspace-status','notes-lookup-status','delete-operation-status','save-operation-status','save-uncertainty-state','draft-warning','delete-uncertainty-state','session-revalidation-state','session-label','notes','create-form','create-submit','create-retry-panel','create-retry-list','email','password','new-title','new-body','device-state','device-detail','device-enroll','device-unlock','device-refresh','device-panel','pwa-state','pwa-install','ops-state'];
  const nodes=new Map(ids.map(id=>[id,new Element()]));
  nodes.get('draft-warning').hidden=true;
  nodes.get('notes-lookup-status').hidden=true;
  nodes.get('delete-operation-status').hidden=true;
  nodes.get('save-operation-status').hidden=true;
  nodes.get('save-uncertainty-state').hidden=true;
  nodes.get('create-retry-panel').hidden=true;
  nodes.get('delete-uncertainty-state').hidden=true;
  const state=new Map([['aleph.auth.version.v1','1'.repeat(32)+'~'+'a'.repeat(32)]]);
  const win=new EventTarget();
  if(process.env.CLAIRE_TEST_NO_STORAGE!=='1')win.localStorage={getItem:key=>state.get(key)??null,setItem:(key,value)=>state.set(key,String(value)),removeItem:key=>state.delete(key)};
  win.PublicKeyCredential=class {};win.matchMedia=()=>({matches:false});win.confirm=()=>true;
  const doc={readyState:'complete',hasFocus:()=>true,querySelector:selector=>nodes.get(selector.slice(1)),getElementById:id=>nodes.get(id),createElement:tag=>new Element(tag)};
  // This fixture begins with an authenticated session; the cookie contains
  // only a synthetic coordination marker and no credential or device proof.
  const cookies=new Map([['__Host-claire_gen','a'.repeat(32)]]);
  Object.defineProperty(doc,'cookie',{
    get(){return [...cookies].map(([key,value])=>`${key}=${value}`).join('; ');},
    set(value){
      const [pair,...attributes]=String(value).split(';');
      const separator=pair.indexOf('=');
      if(separator<1)return;
      const key=pair.slice(0,separator).trim(),cookieValue=pair.slice(separator+1);
      if(attributes.some(attribute=>/^\s*Max-Age\s*=\s*0\s*$/iu.test(attribute)))cookies.delete(key);
      else cookies.set(key,cookieValue);
    },
  });
  let identities=0;win.addEventListener('aleph:identity',()=>identities++);
  let authCalls=0,sessionCalls=0,postCalls=0,notesReads=0,activePrompt=null,cancels=0,loginUserId=loginId,lastCreateId=null;
  let serverNotes=initialNotes||[{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',title:'fixture',body:'fixture'}];
  const post=deferred(),refresh=deferred(),bootstrap=deferred(),logout=deferred(),login=deferred(),notesRead=deferred();
  const queuedWrites=[],queuedCreates=[];let deferPost=false,holdPrompt=false,persisted=false,queueWrites=false,queueCreates=false;
  const timers=[];
  win.SimpleWebAuthnBrowser={
    async startAuthentication(){authCalls++;if(!holdPrompt)return {};activePrompt=deferred();return activePrompt.promise;},
    WebAuthnAbortService:{cancelCeremony(){cancels++;activePrompt?.reject(Object.assign(Error('aborted'),{name:'AbortError'}));}},
  };
  const fixtureFetch=async(path,options={})=>{
    if(path==='/api/auth/session'){
      sessionCalls++;if(sessionCalls===1)return delayBootstrap?bootstrap.promise:reply({accessToken:'fixture-session',user:{email:'fixture@example.invalid',...(initialId===undefined?{}:{id:initialId})}});
      if(delayRefresh)return refresh.promise;
      if(refreshFailure==='network')throw Error('network unavailable');
      if(refreshFailure==='server')return reply({error:'AUTH_BACKEND_UNAVAILABLE'},503);
      if(refreshFailure==='invalid-success')return new Response('{invalid',{status:200,headers:{'Content-Type':'application/json'}});
      if(refreshFailure==='valid')return reply({accessToken:'fixture-refreshed',user:{email:'fixture@example.invalid',...(refreshId===undefined?{}:{id:refreshId})}});
      return reply({error:'UNAUTHORIZED'},401);
    }
    if(path==='/api/auth/logout')return delayLogout?logout.promise:reply({ok:true});
    if(path==='/api/auth/login')return delayLogin?login.promise:reply({accessToken:'fixture-new-session',user:{email:'new@example.invalid',...(loginUserId===undefined?{}:{id:loginUserId})}});
    if(path==='/api/device?action=status')return reply(approved);
    if(path==='/api/device?action=assertion-options')return reply({});
    if(path==='/api/device?action=assertion-verify')return reply(proof);
    if(path==='/api/notes'&&(options.method??'GET')==='GET'){
      notesReads++;
      if(notesReads===(delayNotesRead===true?2:delayNotesRead))return notesRead.promise;
      if(notesReads===2&&notesFailure==='network')throw Error('synthetic network failure');
      if(notesReads===2&&notesFailure==='server')return reply({error:'SYNTHETIC_LIST_FAILURE'},503);
      if(notesReads===2&&notesFailure==='invalid-json')return new Response('{invalid',{status:200,headers:{'Content-Type':'application/json'}});
      if(notesReads>=2&&emptyNotes)return reply([]);
      return reply([...serverNotes,...(persisted?[{id:'fixture-created',title:'fixture new title',body:'fixture new body'}]:[])]);
    }
    if((path==='/api/notes'&&options.method==='POST')||(path.startsWith('/api/notes/')&&['PUT','DELETE'].includes(options.method))){
      postCalls++;
      if(path==='/api/notes'&&options.method==='POST')lastCreateId=JSON.parse(options.body).id;
      if(persistBeforePostResponse&&path==='/api/notes'&&options.method==='POST')persisted=true;
      if(queueCreates&&path==='/api/notes'&&options.method==='POST'){
        const pending=deferred();queuedCreates.push({...pending,body:options.body,signal:options.signal});return pending.promise;
      }
      if(queueWrites&&path.startsWith('/api/notes/')){
        const pending=deferred();queuedWrites.push({path,method:options.method,signal:options.signal,...pending});return pending.promise;
      }
      return deferPost?post.promise:reply({error:'UNAUTHORIZED'},401);
    }
    throw Error('unexpected fixture request');
  };
  const navigator=process.env.CLAIRE_TEST_NO_LOCKS==='1'?{}:{locks:{request:(_name,_options,callback)=>Promise.resolve().then(callback)}};
  const setTimer=captureMutationTimers?(fn,delay)=>{const timer={fn,delay,active:true};timers.push(timer);return timer;}:()=>1;
  const clearTimer=captureMutationTimers?timer=>{if(timer)timer.active=false;}:()=>{};
  const runtimeCrypto=cryptoOverride===undefined?globalThis.crypto:cryptoOverride;
  for(const [key,value] of Object.entries({window:win,document:doc,location:{protocol:'https:',hostname:'fixture.invalid',port:''},BroadcastChannel:undefined,navigator,fetch:fixtureFetch,crypto:runtimeCrypto,setTimeout:setTimer,clearTimeout:clearTimer,requestAnimationFrame:()=>1}))Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  const html=await readFile(process.env.CLAIRE_SESSION_TEST_INDEX || new URL('../public/index.html',import.meta.url),'utf8');
  const inline=html.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];assert.ok(inline);
  const device=pathToFileURL(new URL('../public/device.mjs',import.meta.url).pathname).href;
  const script=inline.replace("import('/device.mjs')",`import(${JSON.stringify(device)})`)
    .replace("import('/operations.mjs')","import('data:text/javascript,export function initOperations(){}')");
  await import(`data:text/javascript;base64,${Buffer.from(script).toString('base64')}#${Math.random()}`);
  const click=id=>nodes.get(id).dispatchEvent(new Event('click'));
  if(!delayBootstrap){
    await until(()=>nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
    click('device-unlock');
    await until(()=>nodes.get('workspace').hidden===false&&nodes.get('notes').children.length===serverNotes.length);
  }
  return {nodes,win,doc,post,refresh,bootstrap,logout,login,notesRead,click,queuedWrites,queuedCreates,fireMutationTimeout(){const timer=timers.find(item=>item.active&&item.delay===30000);assert.ok(timer,'expected active mutation timer');timer.active=false;timer.fn();},get lastCreateId(){return lastCreateId;},get identities(){return identities;},get sessionCalls(){return sessionCalls;},get postCalls(){return postCalls;},get persisted(){return persisted;},get notesReads(){return notesReads;},get cancels(){return cancels;},get authCalls(){return authCalls;},set deferPost(value){deferPost=value;},set holdPrompt(value){holdPrompt=value;},set loginId(value){loginUserId=value;},set serverNotes(value){serverNotes=value;},set queueWrites(value){queueWrites=value;},set queueCreates(value){queueCreates=value;}};
}
for(const refreshFailure of ['http','network']){
  test(`failed ${refreshFailure} session restoration immediately locks the vault and updates identity`,async t=>{
    const x=await setup(t,{refreshFailure});const before=x.identities;
    x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
    await until(()=>x.sessionCalls===2);await tick();await tick();
    assert.equal(x.nodes.get('workspace').hidden,true);
    assert.equal(x.nodes.get('notes').children.length,0);
    assert.equal(x.nodes.get('signed-in').hidden,true);
    assert.equal(x.nodes.get('signed-out').hidden,false);
    assert.ok(x.identities>before);
  });
  test(`failed ${refreshFailure} restoration cancels an authenticator started while an old write was pending`,async t=>{
    const x=await setup(t,{refreshFailure,delayRefresh:true});x.deferPost=true;
    x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));await until(()=>x.postCalls===1);
    x.holdPrompt=true;x.click('device-unlock');await until(()=>x.authCalls===2);
    x.post.resolve(reply({error:'UNAUTHORIZED'},401));await until(()=>x.sessionCalls===2);
    assert.equal(x.cancels,1,'the rejected request must immediately cancel the pending authenticator');
    if(refreshFailure==='http')x.refresh.resolve(reply({error:'UNAUTHORIZED'},401));
    else x.refresh.reject(Error('network unavailable'));
    await tick();await tick();await tick();
    assert.equal(x.cancels,1);
    assert.equal(x.nodes.get('workspace').hidden,true);
    assert.equal(x.nodes.get('signed-in').hidden,true);
    assert.equal(x.nodes.get('signed-out').hidden,false);
  });
}

test('a rejected session locks the vault before a stalled response body completes',async t=>{
  const x=await setup(t,{delayRefresh:true,initialId:ownerA});
  const body=deferred();let bodyRead=false;
  x.nodes.get('new-title').value='fixture draft';
  x.nodes.get('new-body').value='fixture body';
  x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
  await until(()=>x.sessionCalls===2);
  x.refresh.resolve({ok:false,status:401,json(){bodyRead=true;return body.promise;}});
  try {
    await until(()=>bodyRead);
    assert.equal(x.nodes.get('workspace').hidden,true,'a rejected session must immediately lock the vault');
    assert.equal(x.nodes.get('notes').children.length,0);
    assert.equal(x.nodes.get('signed-in').hidden,true);
    assert.equal(x.nodes.get('new-title').value,'');
  } finally {body.resolve({error:'UNAUTHORIZED'});await tick();await tick();}
});

test('a stalled old-session rejection locks only that session while a newer login waits',async t=>{
  const x=await setup(t,{delayRefresh:true,initialId:ownerA,loginId:ownerB});
  const body=deferred();let bodyRead=false;
  x.nodes.get('new-title').value='fixture draft';
  x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
  await until(()=>x.sessionCalls===2);
  x.nodes.get('login-form').dispatchEvent(new Event('submit',{cancelable:true}));
  x.refresh.resolve({ok:false,status:401,json(){bodyRead=true;return body.promise;}});
  try {
    await until(()=>bodyRead);
    assert.equal(x.nodes.get('workspace').hidden,true,'the rejected old vault must be locked');
    assert.equal(x.nodes.get('signed-in').hidden,true);
    assert.match(x.nodes.get('login-status').textContent,/로그인 중/);
  } finally {body.resolve({error:'UNAUTHORIZED'});}
  await until(()=>x.nodes.get('session-label').textContent.includes('new@example.invalid'));
  await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
  x.click('device-unlock');await until(()=>x.nodes.get('workspace').hidden===false);
  assert.equal(x.nodes.get('new-title').value,'','the previous account draft must not be shown');
});

test('a protected 401 hides the vault during session revalidation and retains its draft',async t=>{
  const x=await setup(t,{delayRefresh:true,initialId:ownerA,refreshId:ownerA});
  x.nodes.get('new-title').value='fixture draft';
  x.nodes.get('new-body').value='fixture body';
  x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
  await until(()=>x.sessionCalls===2);
  try {
    assert.equal(x.nodes.get('workspace').hidden,true,'protected contents must be hidden while the rejected session is checked');
    assert.equal(x.nodes.get('notes').children.length,0);
    assert.equal(x.nodes.get('session-revalidation-state').hidden,false);
    assert.match(x.nodes.get('session-revalidation-state').textContent,/세션|인증/);
    x.refresh.resolve(reply({accessToken:'fixture-refreshed',user:{id:ownerA,email:'fixture@example.invalid'}}));
    await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
    assert.equal(x.nodes.get('session-revalidation-state').hidden,true);
    assert.equal(x.nodes.get('workspace').hidden,true);
    x.click('device-unlock');await until(()=>x.nodes.get('workspace').hidden===false);
    assert.equal(x.nodes.get('new-title').value,'fixture draft');
    assert.equal(x.nodes.get('new-body').value,'fixture body');
  } finally {x.refresh.resolve(reply({error:'UNAUTHORIZED'},401));}
});

test('locking a focused vault returns focus to its heading',async t=>{
  const x=await setup(t,{delayRefresh:true});
  const input=x.nodes.get('new-title'),heading=x.nodes.get('vault-title');
  x.doc.body={};x.doc.activeElement=input;x.win.innerHeight=720;
  x.nodes.get('workspace').contains=element=>element===input;
  heading.focus=()=>{x.doc.activeElement=heading;};
  heading.getBoundingClientRect=()=>({top:10,bottom:30});
  x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
  try {
    await until(()=>x.sessionCalls===2);await tick();
    assert.equal(x.doc.activeElement,heading,'focus must stay near the locked vault');
  } finally {x.refresh.resolve(reply({error:'UNAUTHORIZED'},401));}
});

test('locking the vault does not steal focus from another control',async t=>{
  const x=await setup(t,{delayRefresh:true});
  const input=x.nodes.get('new-title'),other=x.nodes.get('email');
  x.doc.body={};x.doc.activeElement=other;
  x.nodes.get('workspace').contains=element=>element===input;
  x.nodes.get('vault-title').focus=()=>{x.doc.activeElement=x.nodes.get('vault-title');};
  x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
  try {
    await until(()=>x.sessionCalls===2);await tick();
    assert.equal(x.doc.activeElement,other,'focus outside the vault must remain untouched');
  } finally {x.refresh.resolve(reply({error:'UNAUTHORIZED'},401));}
});

test('locking the vault preserves focus moved elsewhere during the lock',async t=>{
  const x=await setup(t,{delayRefresh:true});
  const input=x.nodes.get('new-title'),other=x.nodes.get('email'),workspace=x.nodes.get('workspace');
  x.doc.body={};x.doc.activeElement=input;
  workspace.contains=element=>element===input;
  let hidden=workspace.hidden;
  Object.defineProperty(workspace,'hidden',{configurable:true,get:()=>hidden,set:value=>{
    hidden=value;if(value)x.doc.activeElement=other;
  }});
  x.nodes.get('vault-title').focus=()=>{x.doc.activeElement=x.nodes.get('vault-title');};
  x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
  try {
    await until(()=>x.sessionCalls===2);await tick();
    assert.equal(x.doc.activeElement,other,'a newer focus choice must not be overridden');
  } finally {x.refresh.resolve(reply({error:'UNAUTHORIZED'},401));}
});

test('locking a background document does not redirect its focus',async t=>{
  const x=await setup(t,{delayRefresh:true});
  const input=x.nodes.get('new-title'),heading=x.nodes.get('vault-title');
  x.doc.body={};x.doc.activeElement=input;x.doc.hasFocus=()=>false;
  x.nodes.get('workspace').contains=element=>element===input;
  heading.focus=()=>{x.doc.activeElement=heading;};
  x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
  try {
    await until(()=>x.sessionCalls===2);await tick();
    assert.equal(x.doc.activeElement,input,'background focus must not be redirected');
  } finally {x.refresh.resolve(reply({error:'UNAUTHORIZED'},401));}
});

test('a later focus choice prevents the vault heading scroll',async t=>{
  const x=await setup(t,{delayRefresh:true});
  const input=x.nodes.get('new-title'),heading=x.nodes.get('vault-title'),other=x.nodes.get('email');
  x.doc.body={};x.doc.activeElement=input;x.win.innerHeight=720;
  x.nodes.get('workspace').contains=element=>element===input;
  heading.focus=()=>{x.doc.activeElement=heading;};
  heading.getBoundingClientRect=()=>({top:-50,bottom:-30});
  let frame,scrolled=false;
  globalThis.requestAnimationFrame=fn=>{frame=fn;return 1;};
  heading.scrollIntoView=()=>{scrolled=true;};
  x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
  try {
    await until(()=>typeof frame==='function');
    assert.equal(x.doc.activeElement,heading);
    x.doc.activeElement=other;frame();
    assert.equal(scrolled,false,'a later focus choice must not trigger scrolling');
    assert.equal(x.doc.activeElement,other);
  } finally {x.refresh.resolve(reply({error:'UNAUTHORIZED'},401));}
});

test('a reopened vault prevents a delayed heading scroll',async t=>{
  const x=await setup(t,{delayRefresh:true});
  const input=x.nodes.get('new-title'),heading=x.nodes.get('vault-title'),workspace=x.nodes.get('workspace');
  x.doc.body={};x.doc.activeElement=input;x.win.innerHeight=720;
  workspace.contains=element=>element===input;
  heading.focus=()=>{x.doc.activeElement=heading;};
  heading.getBoundingClientRect=()=>({top:-50,bottom:-30});
  let frame,scrolled=false;
  globalThis.requestAnimationFrame=fn=>{frame=fn;return 1;};
  heading.scrollIntoView=()=>{scrolled=true;};
  x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
  try {
    await until(()=>typeof frame==='function');
    workspace.hidden=false;frame();
    assert.equal(scrolled,false,'a reopened vault must not be scrolled back to its heading');
  } finally {x.refresh.resolve(reply({error:'UNAUTHORIZED'},401));}
});

test('device verification cannot reopen a vault while its rejected session is being checked',async t=>{
  const x=await setup(t,{delayRefresh:true,initialId:ownerA});
  x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
  await until(()=>x.sessionCalls===2);
  x.holdPrompt=true;
  try {
    x.click('device-unlock');await tick();await tick();
    assert.equal(x.authCalls,1,'a new device ceremony must not start before session verification');
    assert.equal(x.nodes.get('workspace').hidden,true);
  } finally {x.refresh.resolve(reply({error:'UNAUTHORIZED'},401));}
});

test('a late protected 401 locks the old vault without cancelling a newer login',async t=>{
  const x=await setup(t,{delayLogin:true,initialId:ownerA,loginId:ownerB});
  x.deferPost=true;
  x.nodes.get('new-title').value='fixture draft';
  x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
  await until(()=>x.postCalls===1);
  x.nodes.get('login-form').dispatchEvent(new Event('submit',{cancelable:true}));
  await tick();await tick();
  x.post.resolve(reply({error:'UNAUTHORIZED'},401));
  try {
    await tick();await tick();
    assert.equal(x.nodes.get('workspace').hidden,true,'the rejected old vault must not remain visible');
    assert.match(x.nodes.get('login-status').textContent,/로그인 중/);
  } finally {x.login.resolve(reply({accessToken:'fixture-new-session',user:{email:'new@example.invalid',id:ownerB}}));}
  await until(()=>x.nodes.get('session-label').textContent.includes('new@example.invalid'));
  await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
  x.click('device-unlock');await until(()=>x.nodes.get('workspace').hidden===false);
  assert.equal(x.nodes.get('new-title').value,'','the previous account draft must not be shown');
});

for(const outcome of ['success','failure']){
  test(`late ${outcome} restoration cannot replace a newer login`,async t=>{
    const x=await setup(t,{delayRefresh:true});
    x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));await until(()=>x.sessionCalls===2);
    x.click('logout');await until(()=>x.nodes.get('signed-out').hidden===false);
    x.nodes.get('login-form').dispatchEvent(new Event('submit',{cancelable:true}));
    x.refresh.resolve(outcome==='success'?reply({accessToken:'fixture-old-restoration',user:{email:'old@example.invalid'}}):reply({error:'UNAUTHORIZED'},401));
    await until(()=>x.nodes.get('session-label').textContent.includes('new@example.invalid'));
    await tick();await tick();await tick();
    assert.equal(x.nodes.get('signed-in').hidden,false);
    assert.equal(x.nodes.get('signed-out').hidden,true);
    assert.match(x.nodes.get('session-label').textContent,/new@example.invalid/);
    if(outcome==='failure'){
      await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
      x.click('device-unlock');
      await until(()=>x.nodes.get('workspace').hidden===false);
      x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
      await until(()=>x.postCalls===2);
    }
  });
}

test('a late successful restoration cannot undo logout',async t=>{
  const x=await setup(t,{delayRefresh:true});
  x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));await until(()=>x.sessionCalls===2);
  x.click('logout');await until(()=>x.nodes.get('signed-out').hidden===false);
  x.refresh.resolve(reply({accessToken:'fixture-old-restoration',user:{email:'old@example.invalid'}}));
  await tick();await tick();await tick();
  assert.equal(x.nodes.get('signed-out').hidden,false);
  assert.equal(x.nodes.get('workspace').hidden,true);
  assert.equal(x.nodes.get('signed-in').hidden,true);
});

test('successful session refresh preserves login and requires a fresh device proof',async t=>{
  const x=await setup(t,{refreshFailure:'valid'});
  x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
  await until(()=>x.sessionCalls===2);
  await until(()=>x.nodes.get('workspace').hidden===true&&x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
  assert.equal(x.nodes.get('signed-in').hidden,false);
  x.click('device-unlock');
  await until(()=>x.nodes.get('workspace').hidden===false);
});

test('overlapping expired requests share one session refresh',async t=>{
  const x=await setup(t,{delayRefresh:true});
  x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
  const save=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='수정 저장');
  save.dispatchEvent(new Event('click'));
  await until(()=>x.postCalls===2&&x.sessionCalls===2);
  await tick();await tick();
  assert.equal(x.sessionCalls,2);
  x.refresh.resolve(reply({accessToken:'fixture-refreshed',user:{email:'fixture@example.invalid'}}));
  await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
  assert.equal(x.nodes.get('signed-in').hidden,false);
});

for(const outcome of ['success','failure']){
  test(`late initial restoration ${outcome} cannot lock a newer authenticated session`,async t=>{
    const x=await setup(t,{delayBootstrap:true});
    x.nodes.get('login-form').dispatchEvent(new Event('submit',{cancelable:true}));
    x.bootstrap.resolve(outcome==='success'?reply({accessToken:'fixture-old',user:{email:'old@example.invalid'}}):reply({error:'UNAUTHORIZED'},401));
    await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
    x.click('device-unlock');await until(()=>x.nodes.get('workspace').hidden===false);
    await tick();await tick();await tick();
    assert.equal(x.nodes.get('workspace').hidden,false);
    assert.match(x.nodes.get('session-label').textContent,/new@example.invalid/);
  });
}

test('a stale device rejection cannot lock a newly verified device session',async t=>{
  const x=await setup(t);x.deferPost=true;
  x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));await until(()=>x.postCalls===1);
  x.click('device-refresh');await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
  x.click('device-unlock');await until(()=>x.nodes.get('workspace').hidden===false&&x.authCalls===2);
  x.post.resolve(reply({error:'DEVICE_NOT_VERIFIED'},403));await tick();await tick();await tick();
  assert.equal(x.nodes.get('workspace').hidden,false);
  assert.equal(x.nodes.get('signed-in').hidden,false);
});

test('a stale unauthorized response cannot refresh and lock a newly verified device session',async t=>{
  const x=await setup(t,{refreshFailure:'valid'});x.deferPost=true;
  x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));await until(()=>x.postCalls===1);
  x.click('device-refresh');await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
  x.click('device-unlock');await until(()=>x.nodes.get('workspace').hidden===false&&x.authCalls===2);
  x.post.resolve(reply({error:'UNAUTHORIZED'},401));await tick();await tick();await tick();
  assert.equal(x.sessionCalls,1);
  assert.equal(x.nodes.get('workspace').hidden,false);
});

test('a device rejection whose JSON is delayed cannot lock a device verified during parsing',async t=>{
  const x=await setup(t);x.deferPost=true;
  x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));await until(()=>x.postCalls===1);
  const body=deferred();let parsing=false;
  x.post.resolve({status:403,ok:false,clone:()=>({json:()=>{parsing=true;return body.promise;}}),json:async()=>({error:'DEVICE_NOT_VERIFIED'})});
  await until(()=>parsing);
  x.click('device-refresh');await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
  x.click('device-unlock');await until(()=>x.nodes.get('workspace').hidden===false&&x.authCalls===2);
  body.resolve({error:'DEVICE_NOT_VERIFIED'});await tick();await tick();await tick();
  assert.equal(x.nodes.get('workspace').hidden,false);
});

test('logout immediately removes the visible vault while the server request is pending',async t=>{
  const x=await setup(t,{delayLogout:true});
  x.click('logout');await tick();
  assert.equal(x.nodes.get('workspace').hidden,true);
  assert.equal(x.nodes.get('notes').children.length,0);
  assert.equal(x.nodes.get('signed-in').hidden,true);
  assert.equal(x.nodes.get('signed-out').hidden,false);
  x.logout.resolve(reply({ok:true}));await tick();
});

test('logout immediately cancels an active authenticator while the server request is pending',async t=>{
  const x=await setup(t,{delayLogout:true});
  x.click('device-refresh');await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
  x.holdPrompt=true;x.click('device-unlock');await until(()=>x.authCalls===2);
  x.click('logout');await tick();await tick();
  assert.equal(x.cancels,1);
  assert.equal(x.nodes.get('signed-out').hidden,false);
  x.logout.resolve(reply({ok:true}));await tick();
});

test('a late logout response cannot clear a newer login from the UI',async t=>{
  const x=await setup(t,{delayLogout:true});
  x.click('logout');await until(()=>x.nodes.get('signed-out').hidden===false);
  x.nodes.get('login-form').dispatchEvent(new Event('submit',{cancelable:true}));
  x.logout.resolve(reply({ok:true}));
  await until(()=>x.nodes.get('session-label').textContent.includes('new@example.invalid'));
  await tick();await tick();
  assert.equal(x.nodes.get('signed-in').hidden,false);
  assert.match(x.nodes.get('session-label').textContent,/new@example.invalid/);
});

for(const action of ['create','save','delete']){
  for(const outcome of ['success','delayed-error']){
    test(`stale ${action} ${outcome} cannot change a newer vault`,async t=>{
      const x=await setup(t);x.deferPost=true;
      if(action==='create'){
        x.nodes.get('new-title').value='old';x.nodes.get('new-body').value='old';
        x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
      }else{
        const actions=x.nodes.get('notes').children[0].children[0].children[2];
        actions.children[action==='save'?0:1].dispatchEvent(new Event('click'));
      }
      await until(()=>x.postCalls===1);
      const delayedBody=deferred();let parsing=false;
      if(outcome==='delayed-error'){
        x.post.resolve({ok:false,status:400,json:()=>{parsing=true;return delayedBody.promise;}});
        await until(()=>parsing);
      }
      x.click('device-refresh');await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
      x.click('device-unlock');await until(()=>x.nodes.get('workspace').hidden===false&&x.authCalls===2);
      x.nodes.get('new-title').value='new';x.nodes.get('new-body').value='new';
      x.nodes.get('workspace-status').textContent='new state';const reads=x.notesReads;
      if(outcome==='success')x.post.resolve(action==='create'?reply({id:x.lastCreateId},201):reply({ok:true}));else delayedBody.resolve({error:'OLD_ERROR'});
      await tick();await tick();await tick();
      assert.equal(x.nodes.get('new-title').value,'new');
      assert.equal(x.nodes.get('new-body').value,'new');
      assert.equal(x.nodes.get('workspace-status').textContent,'new state');
      assert.equal(x.notesReads,reads);
    });
  }
}

for(const action of ['create','save','delete']){
  for(const outcome of ['success','error']){
    test(`current ${action} ${outcome} updates its own vault`,async t=>{
      const x=await setup(t);x.deferPost=true;
      if(action==='create'){
        x.nodes.get('new-title').value='fixture';x.nodes.get('new-body').value='fixture';
        x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
      }else{
        const actions=x.nodes.get('notes').children[0].children[0].children[2];
        actions.children[action==='save'?0:1].dispatchEvent(new Event('click'));
      }
      await until(()=>x.postCalls===1);const reads=x.notesReads;
      x.post.resolve(outcome==='success'?(action==='create'?reply({id:x.lastCreateId},201):reply({ok:true})):reply({error:'FIXTURE_ERROR'},400));
      if(outcome==='success'){
        await until(()=>x.notesReads===reads+1);
        if(action==='create')assert.equal(x.nodes.get('new-title').value,'');
      }else{
        await until(()=>x.nodes.get('workspace-status').textContent==='FIXTURE_ERROR');
        assert.equal(x.notesReads,reads);
      }
      assert.equal(x.nodes.get('workspace').hidden,false);
    });
  }
}

test('logout removes the old draft before another account opens the vault',async t=>{
  const x=await setup(t);
  x.nodes.get('new-title').value='old fixture';x.nodes.get('new-body').value='old fixture';
  x.click('logout');await until(()=>x.nodes.get('signed-out').hidden===false);
  x.nodes.get('login-form').dispatchEvent(new Event('submit',{cancelable:true}));
  await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
  x.click('device-unlock');await until(()=>x.nodes.get('workspace').hidden===false);
  assert.equal(x.nodes.get('new-title').value,'');assert.equal(x.nodes.get('new-body').value,'');
});

test('revalidating the same device preserves the current draft',async t=>{
  const x=await setup(t);
  x.nodes.get('new-title').value='fixture';x.nodes.get('new-body').value='fixture';
  x.click('device-refresh');await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
  x.click('device-unlock');await until(()=>x.nodes.get('workspace').hidden===false);
  assert.equal(x.nodes.get('new-title').value,'fixture');assert.equal(x.nodes.get('new-body').value,'fixture');
});

test('refresh for the same verified account preserves the current draft',async t=>{
  const x=await setup(t,{refreshFailure:'valid',initialId:ownerA,refreshId:ownerA});
  x.nodes.get('new-title').value='fixture';x.nodes.get('new-body').value='fixture';
  x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));await until(()=>x.sessionCalls===2);
  await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
  x.click('device-unlock');await until(()=>x.nodes.get('workspace').hidden===false);
  assert.equal(x.nodes.get('new-title').value,'fixture');assert.equal(x.nodes.get('new-body').value,'fixture');
});


for(const notesFailure of ['network','invalid-json']){
  test(`a ${notesFailure} notes read failure retains the session and unsaved draft`,async t=>{
    const x=await setup(t,{notesFailure});
    x.nodes.get('new-title').value='synthetic draft';
    x.nodes.get('new-body').value='synthetic draft content';
    x.click('device-refresh');
    await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
    x.click('device-unlock');
    await until(()=>x.notesReads===2);
    await tick();await tick();
    assert.equal(x.nodes.get('new-title').value,'synthetic draft');
    assert.equal(x.nodes.get('new-body').value,'synthetic draft content');
    assert.equal(x.nodes.get('signed-in').hidden,false);
    assert.equal(x.nodes.get('workspace').hidden,false);
    assert.notEqual(x.nodes.get('workspace-status').textContent,'');
  });
}

async function loginAndVerify(x){
  x.nodes.get('login-form').dispatchEvent(new Event('submit',{cancelable:true}));
  await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
  x.click('device-unlock');
  await until(()=>x.nodes.get('workspace').hidden===false);
}
for(const incoming of [ownerB,undefined,'invalid-id']){
  test(`automatic restoration to a different or unverified owner quarantines the prior owner's draft (${incoming===ownerB?'different':incoming===undefined?'missing':'invalid'})`,async t=>{
    const x=await setup(t,{refreshFailure:'valid',initialId:ownerA,refreshId:incoming,loginId:ownerA});
    x.nodes.get('new-title').value='prior draft';x.nodes.get('new-body').value='prior body';
    x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
    await until(()=>x.sessionCalls===2&&x.nodes.get('workspace').hidden===true);
    await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
    assert.equal(x.nodes.get('new-title').value,'');assert.equal(x.nodes.get('new-body').value,'');
    x.click('device-unlock');await until(()=>x.nodes.get('workspace').hidden===false);
    assert.equal(x.nodes.get('new-title').value,'');assert.equal(x.nodes.get('new-body').value,'');
    x.click('logout');await until(()=>x.nodes.get('signed-out').hidden===false);
    await loginAndVerify(x);
    assert.equal(x.nodes.get('new-title').value,'prior draft');
    assert.equal(x.nodes.get('new-body').value,'prior body');
  });
}
for(const previous of [undefined,'invalid-id']){
  test(`automatic restoration from an unverified owner quarantines the draft without exposing it (${previous===undefined?'missing':'invalid'})`,async t=>{
    const x=await setup(t,{refreshFailure:'valid',initialId:previous,refreshId:ownerA,loginId:ownerA});
    x.nodes.get('new-title').value='unbound draft';x.nodes.get('new-body').value='unbound body';
    x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
    await until(()=>x.sessionCalls===2&&x.nodes.get('workspace').hidden===true);
    await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
    x.click('device-unlock');await until(()=>x.nodes.get('workspace').hidden===false);
    assert.equal(x.nodes.get('new-title').value,'');assert.equal(x.nodes.get('new-body').value,'');
    assert.match(x.nodes.get('workspace-status').textContent,/복구할 수 없습니다/);
    x.click('logout');await until(()=>x.nodes.get('signed-out').hidden===false);
    await loginAndVerify(x);
    assert.equal(x.nodes.get('new-title').value,'');assert.equal(x.nodes.get('new-body').value,'');
  });
}
test('a transport outage quarantines a draft until the same owner reauthenticates the device',async t=>{
  const x=await setup(t,{refreshFailure:'network',initialId:ownerA,loginId:ownerA});
  x.nodes.get('new-title').value='fixture draft';x.nodes.get('new-body').value='fixture body';
  x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
  await until(()=>x.nodes.get('signed-out').hidden===false);
  assert.equal(x.nodes.get('workspace').hidden,true);
  assert.equal(x.nodes.get('new-title').value,'');assert.equal(x.nodes.get('new-body').value,'');
  assert.match(x.nodes.get('login-status').textContent,/탭/);
  x.nodes.get('login-form').dispatchEvent(new Event('submit',{cancelable:true}));
  await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
  assert.equal(x.nodes.get('new-title').value,'');
  x.click('device-unlock');await until(()=>x.nodes.get('workspace').hidden===false);
  assert.equal(x.nodes.get('new-title').value,'fixture draft');
  assert.equal(x.nodes.get('new-body').value,'fixture body');
});
for(const refreshFailure of ['server','invalid-success']){
  test(`a ${refreshFailure} session response quarantines the draft until reauthentication`,async t=>{
    const x=await setup(t,{refreshFailure,initialId:ownerA,loginId:ownerA});
    x.nodes.get('new-title').value='fixture draft';x.nodes.get('new-body').value='fixture body';
    x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
    await until(()=>x.nodes.get('signed-out').hidden===false);
    assert.equal(x.nodes.get('workspace').hidden,true);assert.equal(x.nodes.get('new-title').value,'');
    await loginAndVerify(x);
    assert.equal(x.nodes.get('new-title').value,'fixture draft');
    assert.equal(x.nodes.get('new-body').value,'fixture body');
  });
}
test('the recovered unsaved draft remains identified after an empty notes response',async t=>{
  const x=await setup(t,{refreshFailure:'network',initialId:ownerA,loginId:ownerA,emptyNotes:true});
  x.nodes.get('new-title').value='fixture draft';x.nodes.get('new-body').value='fixture body';
  x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
  await until(()=>x.nodes.get('signed-out').hidden===false);await loginAndVerify(x);
  await until(()=>x.notesReads===2);await tick();await tick();
  assert.equal(x.nodes.get('new-title').value,'fixture draft');
  assert.equal(x.nodes.get('draft-warning').hidden,false);
  assert.match(x.nodes.get('draft-warning').textContent,/저장.*확인/);
});
test('typing while a creation is pending is not erased or overwritten by recovery',async t=>{
  const x=await setup(t,{refreshFailure:'network',initialId:ownerA,loginId:ownerA});
  x.nodes.get('new-title').value='suspended';x.nodes.get('new-body').value='suspended body';
  x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
  await until(()=>x.nodes.get('signed-out').hidden===false);
  x.nodes.get('login-form').dispatchEvent(new Event('submit',{cancelable:true}));
  await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
  x.nodes.get('new-title').value='current';x.nodes.get('new-body').value='current body';
  x.click('device-unlock');await until(()=>x.nodes.get('workspace').hidden===false);
  x.deferPost=true;x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
  await until(()=>x.postCalls===2);
  x.nodes.get('new-title').value='newer';x.nodes.get('new-title').dispatchEvent(new Event('input'));
  x.nodes.get('new-body').value='newer body';x.nodes.get('new-body').dispatchEvent(new Event('input'));
  x.post.resolve(reply({id:x.lastCreateId},201));await until(()=>x.notesReads===3);await tick();
  assert.equal(x.nodes.get('new-title').value,'newer');assert.equal(x.nodes.get('new-body').value,'newer body');
  assert.match(x.nodes.get('workspace-status').textContent,/복구/);
});
test('a quarantined draft is not exposed to a different authenticated owner',async t=>{
  const x=await setup(t,{refreshFailure:'network',initialId:ownerA,loginId:ownerB});
  x.nodes.get('new-title').value='fixture draft';x.nodes.get('new-body').value='fixture body';
  x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
  await until(()=>x.nodes.get('signed-out').hidden===false);
  await loginAndVerify(x);
  assert.equal(x.nodes.get('new-title').value,'');assert.equal(x.nodes.get('new-body').value,'');
  x.click('logout');await until(()=>x.nodes.get('signed-out').hidden===false);
  x.loginId=ownerA;await loginAndVerify(x);
  assert.equal(x.nodes.get('new-title').value,'fixture draft');
  assert.equal(x.nodes.get('new-body').value,'fixture body');
});
test('recovery never overwrites a current nonempty draft',async t=>{
  const x=await setup(t,{refreshFailure:'network',initialId:ownerA,loginId:ownerA});
  x.nodes.get('new-title').value='suspended';x.nodes.get('new-body').value='suspended body';
  x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
  await until(()=>x.nodes.get('signed-out').hidden===false);
  x.nodes.get('login-form').dispatchEvent(new Event('submit',{cancelable:true}));
  await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
  x.nodes.get('new-title').value='current';x.nodes.get('new-body').value='current body';
  x.click('device-unlock');await until(()=>x.nodes.get('workspace').hidden===false);
  assert.equal(x.nodes.get('new-title').value,'current');assert.equal(x.nodes.get('new-body').value,'current body');
  assert.match(x.nodes.get('workspace-status').textContent,/복구/);
  x.nodes.get('new-title').value='';x.nodes.get('new-body').value='';
  x.click('device-refresh');await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
  x.click('device-unlock');await until(()=>x.nodes.get('workspace').hidden===false);
  assert.equal(x.nodes.get('new-title').value,'suspended');assert.equal(x.nodes.get('new-body').value,'suspended body');
});
test('a waiting interrupted draft is restored after the current draft is saved',async t=>{
  const x=await setup(t,{refreshFailure:'network',initialId:ownerA,loginId:ownerA});
  x.nodes.get('new-title').value='suspended';x.nodes.get('new-body').value='suspended body';
  x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
  await until(()=>x.nodes.get('signed-out').hidden===false);
  x.nodes.get('login-form').dispatchEvent(new Event('submit',{cancelable:true}));
  await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
  x.nodes.get('new-title').value='current';x.nodes.get('new-body').value='current body';
  x.click('device-unlock');await until(()=>x.nodes.get('workspace').hidden===false);
  x.deferPost=true;x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
  await until(()=>x.postCalls===2);x.post.resolve(reply({id:x.lastCreateId},201));
  await until(()=>x.nodes.get('new-title').value==='suspended');
  assert.equal(x.nodes.get('new-body').value,'suspended body');
});
test('multiple interrupted drafts are recovered in order without overwriting current input',async t=>{
  const x=await setup(t,{refreshFailure:'network',initialId:ownerA,loginId:ownerA});
  x.nodes.get('new-title').value='first';x.nodes.get('new-body').value='first body';
  x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
  await until(()=>x.nodes.get('signed-out').hidden===false);
  x.nodes.get('login-form').dispatchEvent(new Event('submit',{cancelable:true}));
  await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
  x.nodes.get('new-title').value='second';x.nodes.get('new-body').value='second body';
  x.click('device-unlock');await until(()=>x.nodes.get('workspace').hidden===false);
  x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
  await until(()=>x.nodes.get('signed-out').hidden===false);await loginAndVerify(x);
  assert.equal(x.nodes.get('new-title').value,'first');
  x.deferPost=true;x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
  await until(()=>x.postCalls===3);x.post.resolve(reply({id:x.lastCreateId},201));
  await until(()=>x.nodes.get('new-title').value==='second');
  assert.equal(x.nodes.get('new-body').value,'second body');
});
test('classic page script does not expose session and held drafts as global lexical variables',async()=>{
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
  const inline=html.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];assert.ok(inline);
  const script=inline.replace("import('/device.mjs')",'new Promise(()=>{})')
    .replace("import('/operations.mjs')",'new Promise(()=>{})');
  const nodes=new Map();
  const get=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);};
  const context=createContext({window:new EventTarget(),location:{protocol:'https:',hostname:'fixture.invalid',port:''},document:{cookie:'',querySelector:s=>get(s.slice(1)),getElementById:get},
    fetch:()=>new Promise(()=>{}),Headers,Event,AbortController,setTimeout:()=>0,clearTimeout:()=>{}});
  new Script(script).runInContext(context);
  assert.equal(new Script('typeof interruptedDrafts').runInContext(context),'undefined');
  assert.equal(new Script('typeof session').runInContext(context),'undefined');
});
for(const unavailable of [undefined,'invalid-user-id']){
  test(`unavailable trusted owner ID never exposes an interrupted draft (${unavailable===undefined?'missing':'invalid'})`,async t=>{
    const x=await setup(t,{refreshFailure:'network',initialId:unavailable,loginId:ownerA});
    x.nodes.get('new-title').value='unbound';x.nodes.get('new-body').value='unbound body';
    x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
    await until(()=>x.nodes.get('signed-out').hidden===false);
    assert.match(x.nodes.get('login-status').textContent,/복구할 수 없습니다/);
    await loginAndVerify(x);
    assert.equal(x.nodes.get('new-title').value,'');assert.equal(x.nodes.get('new-body').value,'');
  });
  test(`an unidentifiable later login cannot see another owner's draft (${unavailable===undefined?'missing':'invalid'})`,async t=>{
    const x=await setup(t,{refreshFailure:'network',initialId:ownerA,loginId:unavailable});
    x.nodes.get('new-title').value='fixture draft';x.nodes.get('new-body').value='fixture body';
    x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
    await until(()=>x.nodes.get('signed-out').hidden===false);await loginAndVerify(x);
    assert.equal(x.nodes.get('new-title').value,'');assert.equal(x.nodes.get('new-body').value,'');
    x.click('logout');await until(()=>x.nodes.get('signed-out').hidden===false);
    x.loginId=ownerA;await loginAndVerify(x);
    assert.equal(x.nodes.get('new-title').value,'fixture draft');
    assert.equal(x.nodes.get('new-body').value,'fixture body');
  });
}
test('explicit session refusal quarantines the draft until the same owner reauthenticates',async t=>{
  const x=await setup(t,{refreshFailure:'http',initialId:ownerA,loginId:ownerA});
  x.nodes.get('new-title').value='fixture';x.nodes.get('new-body').value='fixture body';
  x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
  await until(()=>x.nodes.get('signed-out').hidden===false);
  assert.equal(x.nodes.get('new-title').value,'');assert.match(x.nodes.get('login-status').textContent,/탭/);
  await loginAndVerify(x);
  assert.equal(x.nodes.get('new-title').value,'fixture');assert.equal(x.nodes.get('new-body').value,'fixture body');
});
test('logout quarantines the draft and restores it only to the same verified owner',async t=>{
  const x=await setup(t,{initialId:ownerA,loginId:ownerB});
  x.nodes.get('new-title').value='fixture';x.nodes.get('new-body').value='fixture body';
  x.click('logout');await until(()=>x.nodes.get('signed-out').hidden===false);
  assert.equal(x.nodes.get('new-title').value,'');assert.match(x.nodes.get('login-status').textContent,/탭/);
  await loginAndVerify(x);
  assert.equal(x.nodes.get('new-title').value,'');assert.equal(x.nodes.get('new-body').value,'');
  x.click('logout');await until(()=>x.nodes.get('signed-out').hidden===false);
  x.loginId=ownerA;await loginAndVerify(x);
  assert.equal(x.nodes.get('new-title').value,'fixture');assert.equal(x.nodes.get('new-body').value,'fixture body');
});

test('a committed create with a lost response warns that it may already be saved',async t=>{
  const x=await setup(t,{initialId:ownerA,loginId:ownerA,persistBeforePostResponse:true});
  x.deferPost=true;
  x.nodes.get('new-title').value='fixture new title';x.nodes.get('new-body').value='fixture new body';
  x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
  await until(()=>x.postCalls===1&&x.persisted);
  try {
    x.click('logout');await until(()=>x.nodes.get('signed-out').hidden===false);
    await loginAndVerify(x);
    await until(()=>x.nodes.get('notes').children.length===2);
    assert.equal(x.nodes.get('new-title').value,'fixture new title');
    assert.equal(x.nodes.get('new-body').value,'fixture new body');
    const warning=x.nodes.get('draft-warning');
    assert.equal(warning.hidden,false);
    assert.match(warning.textContent,/저장.*확인/);
    assert.match(warning.textContent,/나중.*반영/,'the earlier request can arrive after a list check');
    assert.doesNotMatch(warning.textContent,/아직 저장하지 않았습니다/);
    x.nodes.get('new-title').value='';x.nodes.get('new-body').value='';
    x.nodes.get('new-body').dispatchEvent(new Event('input'));
    assert.equal(warning.hidden,true,'clearing the recovered draft removes its notice');
  } finally {x.post.resolve(reply({id:x.lastCreateId},201));await tick();await tick();await tick();}
});

test('a recovered draft warning remains visible when the notes list fails to load',async t=>{
  const x=await setup(t,{initialId:ownerA,loginId:ownerA,persistBeforePostResponse:true,notesFailure:'network'});
  x.deferPost=true;
  x.nodes.get('new-title').value='fixture new title';x.nodes.get('new-body').value='fixture new body';
  x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
  await until(()=>x.postCalls===1&&x.persisted);
  try {
    x.click('logout');await until(()=>x.nodes.get('signed-out').hidden===false);
    await loginAndVerify(x);
    await until(()=>x.notesReads===2);await tick();
    const warning=x.nodes.get('draft-warning');
    assert.equal(warning.hidden,false);
    assert.match(warning.textContent,/저장.*확인/);
    assert.match(x.nodes.get('workspace-status').textContent,/network/);
  } finally {x.post.resolve(reply({id:x.lastCreateId},201));await tick();await tick();await tick();}
});

for(const outcome of ['network','server']){
  test(`a create with an uncertain ${outcome} response asks the user to check the list`,async t=>{
    const x=await setup(t,{initialId:ownerA,persistBeforePostResponse:true});
    x.deferPost=true;
    x.nodes.get('new-title').value='fixture new title';x.nodes.get('new-body').value='fixture new body';
    x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
    await until(()=>x.postCalls===1&&x.persisted);
    if(outcome==='network')x.post.reject(Error('synthetic connection failure'));
    else x.post.resolve(reply({error:'SYNTHETIC_FAILURE'},500));
    await until(()=>x.nodes.get('workspace-status').textContent.includes(outcome==='network'?'connection':'SYNTHETIC_FAILURE'));
    const warning=x.nodes.get('draft-warning');
    assert.equal(warning.hidden,false);
    assert.match(warning.textContent,/저장.*확인/);
    assert.equal(x.nodes.get('new-title').value,'fixture new title');
    assert.equal(x.nodes.get('new-body').value,'fixture new body');
  });
}

test('an explicit client rejection does not claim the create may have been saved',async t=>{
  const x=await setup(t,{initialId:ownerA});
  x.deferPost=true;
  x.nodes.get('new-title').value='fixture title';x.nodes.get('new-body').value='fixture body';
  x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
  await until(()=>x.postCalls===1);
  x.post.resolve(reply({error:'INVALID_NOTE'},400));
  await until(()=>x.nodes.get('workspace-status').textContent.includes('INVALID_NOTE'));
  assert.equal(x.nodes.get('draft-warning').hidden,true);
});

test('a pending creation blocks repeat submission while preserving later input',async t=>{
  const x=await setup(t,{initialId:ownerA});x.deferPost=true;
  x.nodes.get('new-title').value='fixture first';x.nodes.get('new-body').value='fixture body';
  const form=x.nodes.get('create-form'),button=x.nodes.get('create-submit');
  try {
    form.dispatchEvent(new Event('submit',{cancelable:true}));await until(()=>x.postCalls===1);
    assert.equal(button.disabled,false,'the focused submit button stays focusable');
    assert.equal(button.getAttribute('aria-disabled'),'true');
    x.nodes.get('new-title').value='fixture later';x.nodes.get('new-title').dispatchEvent(new Event('input'));
    form.dispatchEvent(new Event('submit',{cancelable:true}));await tick();
    assert.equal(x.postCalls,1,'a second submit must not send another POST');
    x.post.resolve(reply({id:x.lastCreateId},201));await until(()=>x.notesReads>=2);await tick();
    assert.equal(x.nodes.get('new-title').value,'fixture later');
    assert.equal(button.getAttribute('aria-disabled'),null);
  } finally {x.post.resolve(reply({error:'SYNTHETIC_REJECTION'},400));await tick();await tick();}
});

for(const [initialId,loginId,blocks,label] of [[ownerA,ownerA,true,'same owner'],[ownerA,ownerB,false,'different owner'],[undefined,ownerA,true,'unknown initial owner'],[ownerA,undefined,true,'unknown current owner']])
  test(`a pending creation applies the correct reservation after ${label} reauthentication`,async t=>{
    const x=await setup(t,{initialId,loginId});x.deferPost=true;
    x.nodes.get('new-title').value='fixture first';x.nodes.get('new-body').value='fixture body';
    const form=x.nodes.get('create-form');
    try {
      form.dispatchEvent(new Event('submit',{cancelable:true}));await until(()=>x.postCalls===1);
      x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);
      await loginAndVerify(x);await until(()=>x.notesReads>=2);await tick();
      x.nodes.get('new-title').value='fixture current';x.nodes.get('new-body').value='fixture current body';
      form.dispatchEvent(new Event('submit',{cancelable:true}));
      if(blocks){await tick();await tick();assert.equal(x.postCalls,1);}
      else await until(()=>x.postCalls===2);
    } finally {x.post.resolve(reply({error:'SYNTHETIC_REJECTION'},400));await tick();await tick();}
  });

test('an older owner creation completion does not release the newer owner reservation',async t=>{
  const x=await setup(t,{initialId:ownerA,loginId:ownerB});x.queueCreates=true;
  const form=x.nodes.get('create-form'),button=x.nodes.get('create-submit');
  try {
    x.nodes.get('new-title').value='fixture a';x.nodes.get('new-body').value='fixture a body';
    form.dispatchEvent(new Event('submit',{cancelable:true}));await until(()=>x.queuedCreates.length===1);
    x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);
    await loginAndVerify(x);await until(()=>x.notesReads>=2);await tick();
    x.nodes.get('new-title').value='fixture b';x.nodes.get('new-body').value='fixture b body';
    form.dispatchEvent(new Event('submit',{cancelable:true}));await until(()=>x.queuedCreates.length===2);
    x.queuedCreates[0].resolve(reply({id:JSON.parse(x.queuedCreates[0].body).id},201));await tick();await tick();
    assert.equal(button.getAttribute('aria-disabled'),'true');
    form.dispatchEvent(new Event('submit',{cancelable:true}));await tick();assert.equal(x.queuedCreates.length,2);
    x.queuedCreates[1].resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await until(()=>button.getAttribute('aria-disabled')===null);
  } finally {
    for(const request of x.queuedCreates)request.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

test('a creation sends a client-generated UUID so transport retries use the same note ID',async t=>{
  const x=await setup(t,{initialId:ownerA});x.queueCreates=true;
  try {
    x.nodes.get('new-title').value='fixture create';x.nodes.get('new-body').value='fixture body';
    x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
    await until(()=>x.queuedCreates.length===1);
    const body=JSON.parse(x.queuedCreates[0].body);
    assert.match(body.id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
    assert.equal(body.title,'fixture create');assert.equal(body.body,'fixture body');
  } finally {
    for(const request of x.queuedCreates)request.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

test('creation does not send a request when secure random IDs are unavailable',async t=>{
  const x=await setup(t,{initialId:ownerA,loginId:ownerA,cryptoOverride:{},delayBootstrap:true});
  await loginAndVerify(x);x.queueCreates=true;
  x.nodes.get('new-title').value='fixture create';x.nodes.get('new-body').value='fixture body';
  x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
  await until(()=>x.nodes.get('workspace-status').textContent.includes('식별자'));
  assert.equal(x.queuedCreates.length,0);
  assert.equal(x.nodes.get('create-submit').getAttribute('aria-disabled'),null);
  assert.equal(x.nodes.get('new-title').value,'fixture create');
});

test('a creation ID conflict does not assume that the request failed to save',async t=>{
  const x=await setup(t,{initialId:ownerA});x.queueCreates=true;
  try {
    x.nodes.get('new-title').value='fixture create';x.nodes.get('new-body').value='fixture body';
    x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
    await until(()=>x.queuedCreates.length===1);
    x.queuedCreates[0].resolve(reply({error:'NOTE_ID_EXISTS'},409));
    await until(()=>x.nodes.get('workspace-status').textContent.includes('NOTE_ID_EXISTS'));
    assert.equal(x.nodes.get('draft-warning').hidden,false);
    assert.match(x.nodes.get('draft-warning').textContent,/저장.*나중.*반영/);
    assert.equal(x.nodes.get('new-title').value,'fixture create');
  } finally {
    for(const request of x.queuedCreates)request.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

test('a creation ID conflict warns before a delayed response body is read',async t=>{
  const x=await setup(t,{initialId:ownerA});x.queueCreates=true;const body=deferred();
  try {
    x.nodes.get('new-title').value='fixture create';x.nodes.get('new-body').value='fixture body';
    x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
    await until(()=>x.queuedCreates.length===1);
    x.queuedCreates[0].resolve({ok:false,status:409,json:()=>body.promise});
    await until(()=>!x.nodes.get('draft-warning').hidden);
    assert.match(x.nodes.get('draft-warning').textContent,/저장.*나중.*반영/);
  } finally {body.resolve({error:'NOTE_ID_EXISTS'});await tick();await tick();}
});

for(const [status,result,label] of [
  [200,{unexpected:'fixture'},'unexpected success status'],
  [201,{id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'},'different UUID'],
  [201,{},'missing UUID'],
]) test(`a first creation retains its draft when the response has ${label}`,async t=>{
  const x=await setup(t,{initialId:ownerA});x.queueCreates=true;
  try {
    x.nodes.get('new-title').value='fixture original';x.nodes.get('new-body').value='fixture body';
    x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));await until(()=>x.queuedCreates.length===1);
    const original=JSON.parse(x.queuedCreates[0].body);
    x.queuedCreates[0].resolve(reply(result,status));
    await until(()=>!x.nodes.get('create-retry-panel').hidden);
    assert.equal(x.nodes.get('new-title').value,'fixture original');
    assert.equal(x.nodes.get('new-body').value,'fixture body');
    assert.equal(x.nodes.get('draft-warning').hidden,false);
    assert.doesNotMatch(x.nodes.get('workspace-status').textContent,/추가했습니다/);
    await until(()=>x.nodes.get('create-submit').getAttribute('aria-disabled')===null);
    descendants(x.nodes.get('create-retry-list'),'button').find(item=>item.textContent==='이 요청 다시 시도').dispatchEvent(new Event('click'));
    await until(()=>x.queuedCreates.length===2);
    assert.deepEqual(JSON.parse(x.queuedCreates[1].body),original);
  } finally {
    for(const request of x.queuedCreates)request.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

test('a first creation retains its draft when the 201 response body times out',async t=>{
  const x=await setup(t,{initialId:ownerA,captureMutationTimers:true});x.queueCreates=true;const body=deferred();
  try {
    x.nodes.get('new-title').value='fixture original';x.nodes.get('new-body').value='fixture body';
    x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));await until(()=>x.queuedCreates.length===1);
    const original=JSON.parse(x.queuedCreates[0].body);
    x.queuedCreates[0].resolve({ok:true,status:201,json:()=>body.promise});await tick();x.fireMutationTimeout();
    await until(()=>!x.nodes.get('create-retry-panel').hidden);
    assert.equal(x.nodes.get('new-title').value,'fixture original');
    assert.equal(x.nodes.get('draft-warning').hidden,false);
    assert.equal(x.queuedCreates[0].signal.aborted,true);
    await until(()=>x.nodes.get('create-submit').getAttribute('aria-disabled')===null);
    descendants(x.nodes.get('create-retry-list'),'button').find(item=>item.textContent==='이 요청 다시 시도').dispatchEvent(new Event('click'));
    await until(()=>x.queuedCreates.length===2);assert.deepEqual(JSON.parse(x.queuedCreates[1].body),original);
  } finally {
    body.resolve({id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'});
    for(const request of x.queuedCreates)request.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

for(const [response,label] of [
  [()=>new Response('{invalid',{status:201,headers:{'Content-Type':'application/json'}}),'invalid JSON'],
  [()=>new Response(null,{status:204}),'empty 204'],
]) test(`a first creation keeps its retry record for ${label}`,async t=>{
  const x=await setup(t,{initialId:ownerA});x.queueCreates=true;
  try {
    x.nodes.get('new-title').value='fixture original';x.nodes.get('new-body').value='fixture body';
    x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));await until(()=>x.queuedCreates.length===1);
    x.queuedCreates[0].resolve(response());await until(()=>!x.nodes.get('create-retry-panel').hidden);
    assert.equal(x.nodes.get('new-title').value,'fixture original');
    assert.equal(x.nodes.get('draft-warning').hidden,false);
    assert.ok(descendants(x.nodes.get('create-retry-list'),'button').some(item=>item.textContent==='이 요청 다시 시도'&&!item.hidden));
  } finally {
    for(const request of x.queuedCreates)request.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

for(const status of [304,408]) test(`a first creation treats an unexpected ${status} as unconfirmed`,async t=>{
  const x=await setup(t,{initialId:ownerA});x.queueCreates=true;
  try {
    x.nodes.get('new-title').value='fixture original';x.nodes.get('new-body').value='fixture body';
    x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));await until(()=>x.queuedCreates.length===1);
    x.queuedCreates[0].resolve(status===304?new Response(null,{status}):reply({error:'SYNTHETIC_FAILURE'},status));
    await until(()=>!x.nodes.get('create-retry-panel').hidden);
    assert.equal(x.nodes.get('new-title').value,'fixture original');
    assert.equal(x.nodes.get('draft-warning').hidden,false);
  } finally {
    for(const request of x.queuedCreates)request.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

test('a late first-creation response body cannot resurrect a dismissed timed-out record',async t=>{
  const x=await setup(t,{initialId:ownerA,captureMutationTimers:true});x.queueCreates=true;const body=deferred();
  try {
    x.nodes.get('new-title').value='fixture original';x.nodes.get('new-body').value='fixture body';
    x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));await until(()=>x.queuedCreates.length===1);
    const id=JSON.parse(x.queuedCreates[0].body).id;
    x.queuedCreates[0].resolve({ok:true,status:201,json:()=>body.promise});await tick();x.fireMutationTimeout();
    await until(()=>!x.nodes.get('create-retry-panel').hidden&&x.nodes.get('create-submit').getAttribute('aria-disabled')===null);
    descendants(x.nodes.get('create-retry-list'),'button').find(item=>item.textContent==='이 기록 보관 중단').dispatchEvent(new Event('click'));
    assert.equal(x.nodes.get('create-retry-panel').hidden,true);
    body.resolve({id});await tick();await tick();
    assert.equal(x.nodes.get('create-retry-panel').hidden,true);
    assert.equal(x.nodes.get('new-title').value,'fixture original');
  } finally {
    body.resolve({id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'});
    for(const request of x.queuedCreates)request.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

test('a first creation accepts only a matching 201 response and clears its submitted draft',async t=>{
  const x=await setup(t,{initialId:ownerA});x.queueCreates=true;
  try {
    x.nodes.get('new-title').value='fixture original';x.nodes.get('new-body').value='fixture body';
    x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));await until(()=>x.queuedCreates.length===1);
    const original=JSON.parse(x.queuedCreates[0].body);
    x.queuedCreates[0].resolve(reply({id:original.id},201));await until(()=>x.notesReads>=2);await tick();
    assert.equal(x.nodes.get('new-title').value,'');assert.equal(x.nodes.get('new-body').value,'');
    assert.equal(x.nodes.get('create-retry-panel').hidden,true);
    assert.match(x.nodes.get('workspace-status').textContent,/추가했습니다/);
  } finally {
    for(const request of x.queuedCreates)request.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

test('a stale malformed creation success remains unconfirmed and scoped to its original owner',async t=>{
  const x=await setup(t,{initialId:ownerA,loginId:ownerB});x.queueCreates=true;
  try {
    x.nodes.get('new-title').value='fixture protected';x.nodes.get('new-body').value='fixture body';
    x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));await until(()=>x.queuedCreates.length===1);
    x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);await loginAndVerify(x);await tick();
    x.queuedCreates[0].resolve(reply({id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'},201));await tick();await tick();
    assert.equal(x.nodes.get('create-retry-panel').hidden,true);
    x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);x.loginId=ownerA;
    await loginAndVerify(x);await until(()=>!x.nodes.get('create-retry-panel').hidden);
    assert.ok(descendants(x.nodes.get('create-retry-list'),'button').some(item=>item.textContent==='이 요청 다시 시도'&&!item.hidden));
    assert.ok(descendants(x.nodes.get('create-retry-list'),'p').every(item=>!/생성 성공 응답/.test(item.textContent)));
  } finally {
    for(const request of x.queuedCreates)request.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

test('an explicit retry sends the selected original creation and preserves the current draft',async t=>{
  const x=await setup(t,{initialId:ownerA});x.queueCreates=true;
  try {
    x.nodes.get('new-title').value='fixture original';x.nodes.get('new-body').value='fixture original body';
    x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));await until(()=>x.queuedCreates.length===1);
    const original=JSON.parse(x.queuedCreates[0].body);
    x.queuedCreates[0].reject(Error('synthetic interrupted response'));
    await until(()=>!x.nodes.get('create-retry-panel').hidden);
    x.nodes.get('new-title').value='fixture later';x.nodes.get('new-body').value='fixture later body';
    const retry=descendants(x.nodes.get('create-retry-list'),'button').find(item=>item.textContent==='이 요청 다시 시도');
    assert.ok(retry);retry.dispatchEvent(new Event('click'));await until(()=>x.queuedCreates.length===2);
    assert.ok(descendants(x.nodes.get('create-retry-list'),'p').some(item=>/재시도 중/.test(item.textContent)));
    assert.deepEqual(JSON.parse(x.queuedCreates[1].body),original);
    x.queuedCreates[1].resolve(reply({error:'NOTE_ID_EXISTS'},409));await tick();await tick();
    assert.equal(x.nodes.get('new-title').value,'fixture later');
    assert.equal(x.nodes.get('new-body').value,'fixture later body');
    assert.equal(x.nodes.get('create-retry-panel').hidden,false,'409 must not prove the previous request succeeded');
  } finally {
    for(const request of x.queuedCreates)request.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

test('uncertain creation records remain isolated to their verified owner',async t=>{
  const x=await setup(t,{initialId:ownerA,loginId:ownerB});x.queueCreates=true;
  try {
    x.nodes.get('new-title').value='fixture owner a';x.nodes.get('new-body').value='fixture owner a body';
    x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));await until(()=>x.queuedCreates.length===1);
    x.queuedCreates[0].reject(Error('synthetic interrupted response'));
    await until(()=>!x.nodes.get('create-retry-panel').hidden);
    x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);
    await loginAndVerify(x);await until(()=>x.notesReads>=2);await tick();
    assert.equal(x.nodes.get('create-retry-panel').hidden,true);
    assert.equal(x.nodes.get('create-retry-list').children.length,0);
    x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);
    x.loginId=ownerA;await loginAndVerify(x);await until(()=>x.notesReads>=3);await tick();
    assert.equal(x.nodes.get('create-retry-panel').hidden,false);
  } finally {
    for(const request of x.queuedCreates)request.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

test('a new unidentified session cannot see the previous unidentified creation record',async t=>{
  const x=await setup(t);x.queueCreates=true;
  try {
    x.nodes.get('new-title').value='fixture unbound';x.nodes.get('new-body').value='fixture body';
    x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));await until(()=>x.queuedCreates.length===1);
    x.queuedCreates[0].reject(Error('synthetic interrupted response'));
    await until(()=>!x.nodes.get('create-retry-panel').hidden);
    x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);
    await loginAndVerify(x);await until(()=>x.notesReads>=2);await tick();
    assert.equal(x.nodes.get('create-retry-panel').hidden,true);
    assert.equal(x.nodes.get('create-retry-list').children.length,0);
  } finally {
    for(const request of x.queuedCreates)request.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

test('a late creation success informs its owner without clearing a newer vault draft',async t=>{
  const x=await setup(t,{initialId:ownerA,loginId:ownerA});x.queueCreates=true;
  try {
    x.nodes.get('new-title').value='fixture original';x.nodes.get('new-body').value='fixture original body';
    x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));await until(()=>x.queuedCreates.length===1);
    x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);
    await loginAndVerify(x);await until(()=>x.notesReads>=2);await tick();
    x.nodes.get('new-title').value='fixture later';x.nodes.get('new-body').value='fixture later body';
    x.queuedCreates[0].resolve(reply({id:JSON.parse(x.queuedCreates[0].body).id},201));
    await until(()=>!x.nodes.get('create-retry-panel').hidden);
    const values=[];const visit=node=>{if(node.hidden)return;if(node.textContent)values.push(node.textContent);for(const child of node.children)visit(child);};
    visit(x.nodes.get('create-retry-list'));
    assert.ok(values.some(text=>/성공 응답/.test(text)),'the previous response must be visible');
    assert.equal(x.nodes.get('new-title').value,'fixture later');
    assert.equal(x.nodes.get('new-body').value,'fixture later body');
  } finally {
    for(const request of x.queuedCreates)request.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

for(const [status,result,label] of [[200,{unexpected:'fixture'},'unexpected status'],[201,{id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'},'different id']])
  test(`an explicit retry does not claim success for ${label}`,async t=>{
    const x=await setup(t,{initialId:ownerA});x.queueCreates=true;
    try {
      x.nodes.get('new-title').value='fixture original';x.nodes.get('new-body').value='fixture body';
      x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));await until(()=>x.queuedCreates.length===1);
      x.queuedCreates[0].reject(Error('synthetic interrupted response'));
      await until(()=>!x.nodes.get('create-retry-panel').hidden&&x.nodes.get('create-submit').getAttribute('aria-disabled')===null);
      const retry=descendants(x.nodes.get('create-retry-list'),'button').find(item=>item.textContent==='이 요청 다시 시도');
      retry.dispatchEvent(new Event('click'));await until(()=>x.queuedCreates.length===2);
      x.queuedCreates[1].resolve(reply(result,status));await tick();await tick();await tick();
      const currentRetry=descendants(x.nodes.get('create-retry-list'),'button').find(item=>item.textContent==='이 요청 다시 시도');
      assert.ok(currentRetry&&!currentRetry.hidden,'unverified success must remain retryable');
      assert.ok(descendants(x.nodes.get('create-retry-list'),'p').every(item=>!/생성 성공 응답/.test(item.textContent)));
    } finally {
      for(const request of x.queuedCreates)request.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
      await tick();await tick();
    }
  });

test('an interrupted explicit retry reports its own unconfirmed result',async t=>{
  const x=await setup(t,{initialId:ownerA});x.queueCreates=true;
  try {
    x.nodes.get('new-title').value='fixture original';x.nodes.get('new-body').value='fixture body';
    x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));await until(()=>x.queuedCreates.length===1);
    x.queuedCreates[0].reject(Error('synthetic interrupted response'));
    await until(()=>!x.nodes.get('create-retry-panel').hidden&&x.nodes.get('create-submit').getAttribute('aria-disabled')===null);
    const retry=descendants(x.nodes.get('create-retry-list'),'button').find(item=>item.textContent==='이 요청 다시 시도');
    retry.dispatchEvent(new Event('click'));await until(()=>x.queuedCreates.length===2);
    x.queuedCreates[1].reject(Error('synthetic retry interruption'));
    await until(()=>descendants(x.nodes.get('create-retry-list'),'p').some(item=>/재시도.*확인하지 못/.test(item.textContent)));
    assert.equal(x.nodes.get('create-retry-panel').hidden,false);
  } finally {
    for(const request of x.queuedCreates)request.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

test('a retry with a stalled 201 body stays unconfirmed after its timeout',async t=>{
  const x=await setup(t,{initialId:ownerA,captureMutationTimers:true});x.queueCreates=true;const body=deferred();
  try {
    x.nodes.get('new-title').value='fixture original';x.nodes.get('new-body').value='fixture body';
    x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));await until(()=>x.queuedCreates.length===1);
    x.queuedCreates[0].reject(Error('synthetic failure'));
    await until(()=>!x.nodes.get('create-retry-panel').hidden&&x.nodes.get('create-submit').getAttribute('aria-disabled')===null);
    descendants(x.nodes.get('create-retry-list'),'button').find(item=>item.textContent==='이 요청 다시 시도').dispatchEvent(new Event('click'));
    await until(()=>x.queuedCreates.length===2);x.queuedCreates[1].resolve({ok:true,status:201,json:()=>body.promise});
    await tick();x.fireMutationTimeout();
    await until(()=>descendants(x.nodes.get('create-retry-list'),'p').some(item=>/재시도.*확인하지 못/.test(item.textContent)));
    const retry=descendants(x.nodes.get('create-retry-list'),'button').find(item=>item.textContent==='이 요청 다시 시도');
    assert.ok(retry&&!retry.hidden);assert.equal(x.queuedCreates[1].signal.aborted,true);
  } finally {
    body.resolve({id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'});
    for(const request of x.queuedCreates)request.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

test('a completed creation does not keep the composer blocked while the list is stalled',async t=>{
  const x=await setup(t,{initialId:ownerA,delayNotesRead:2});x.queueCreates=true;
  try {
    x.nodes.get('new-title').value='fixture original';x.nodes.get('new-body').value='fixture body';
    x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));await until(()=>x.queuedCreates.length===1);
    const id=JSON.parse(x.queuedCreates[0].body).id;
    x.queuedCreates[0].resolve(reply({id},201));await until(()=>x.notesReads===2);await tick();
    assert.equal(x.nodes.get('create-submit').getAttribute('aria-disabled'),null);
  } finally {
    x.notesRead.resolve(reply([]));
    for(const request of x.queuedCreates)request.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

test('a confirmed retry does not keep the composer blocked while the list is stalled',async t=>{
  const x=await setup(t,{initialId:ownerA,delayNotesRead:2});x.queueCreates=true;
  try {
    x.nodes.get('new-title').value='fixture original';x.nodes.get('new-body').value='fixture body';
    x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));await until(()=>x.queuedCreates.length===1);
    const id=JSON.parse(x.queuedCreates[0].body).id;
    x.queuedCreates[0].reject(Error('synthetic interrupted response'));
    await until(()=>!x.nodes.get('create-retry-panel').hidden&&x.nodes.get('create-submit').getAttribute('aria-disabled')===null);
    descendants(x.nodes.get('create-retry-list'),'button').find(item=>item.textContent==='이 요청 다시 시도').dispatchEvent(new Event('click'));
    await until(()=>x.queuedCreates.length===2);x.queuedCreates[1].resolve(reply({id},201));
    await until(()=>x.notesReads===2);await tick();
    assert.equal(x.nodes.get('create-submit').getAttribute('aria-disabled'),null);
    assert.equal(x.nodes.get('new-title').value,'fixture original');
  } finally {
    x.notesRead.resolve(reply([]));
    for(const request of x.queuedCreates)request.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

test('two uncertain creations stay distinct and only the chosen request is retried',async t=>{
  const x=await setup(t,{initialId:ownerA});x.queueCreates=true;
  const form=x.nodes.get('create-form'),list=x.nodes.get('create-retry-list');
  try {
    x.nodes.get('new-title').value='fixture first';x.nodes.get('new-body').value='fixture first body';
    form.dispatchEvent(new Event('submit',{cancelable:true}));await until(()=>x.queuedCreates.length===1);
    const first=JSON.parse(x.queuedCreates[0].body);
    x.queuedCreates[0].reject(Error('synthetic failure'));
    await until(()=>!x.nodes.get('create-retry-panel').hidden&&x.nodes.get('create-submit').getAttribute('aria-disabled')===null);
    x.nodes.get('new-title').value='fixture second';x.nodes.get('new-body').value='fixture second body';
    form.dispatchEvent(new Event('submit',{cancelable:true}));await until(()=>x.queuedCreates.length===2);
    x.queuedCreates[1].resolve(reply({error:'SYNTHETIC_FAILURE'},503));
    await until(()=>descendants(list,'article').length===2&&x.nodes.get('create-submit').getAttribute('aria-disabled')===null);
    const retry=descendants(list,'button').find(item=>item.textContent==='이 요청 다시 시도');
    x.win.confirm=()=>false;retry.dispatchEvent(new Event('click'));await tick();assert.equal(x.queuedCreates.length,2);
    x.win.confirm=()=>true;retry.dispatchEvent(new Event('click'));await until(()=>x.queuedCreates.length===3);
    assert.deepEqual(JSON.parse(x.queuedCreates[2].body),first);
    x.queuedCreates[2].resolve(reply({id:first.id},201));
    await until(()=>descendants(list,'p').some(item=>/이번 재시도.*성공 응답.*이전 요청.*나중/.test(item.textContent)));
    assert.equal(descendants(list,'article').length,2);
    assert.equal(x.nodes.get('new-title').value,'fixture second');
  } finally {
    for(const request of x.queuedCreates)request.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

test('a timed-out creation record cannot be resurrected by a later response after dismissal',async t=>{
  const x=await setup(t,{initialId:ownerA,captureMutationTimers:true});x.queueCreates=true;
  try {
    x.nodes.get('new-title').value='fixture original';x.nodes.get('new-body').value='fixture body';
    x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));await until(()=>x.queuedCreates.length===1);
    x.fireMutationTimeout();
    await until(()=>!x.nodes.get('create-retry-panel').hidden&&x.nodes.get('create-submit').getAttribute('aria-disabled')===null);
    assert.equal(x.queuedCreates[0].signal.aborted,true);
    descendants(x.nodes.get('create-retry-list'),'button').find(item=>item.textContent==='이 기록 보관 중단').dispatchEvent(new Event('click'));
    assert.equal(x.nodes.get('create-retry-panel').hidden,true);
    x.queuedCreates[0].resolve(reply({error:'NOTE_ID_EXISTS'},409));await tick();await tick();
    assert.equal(x.nodes.get('create-retry-panel').hidden,true);
  } finally {
    for(const request of x.queuedCreates)request.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

test('a separate creation after an uncertain request requires explicit confirmation and a new UUID',async t=>{
  const x=await setup(t,{initialId:ownerA});x.queueCreates=true;const form=x.nodes.get('create-form');
  try {
    x.nodes.get('new-title').value='fixture same';x.nodes.get('new-body').value='fixture body';
    form.dispatchEvent(new Event('submit',{cancelable:true}));await until(()=>x.queuedCreates.length===1);
    const first=JSON.parse(x.queuedCreates[0].body);
    x.queuedCreates[0].reject(Error('synthetic failure'));
    await until(()=>!x.nodes.get('create-retry-panel').hidden&&x.nodes.get('create-submit').getAttribute('aria-disabled')===null);
    x.win.confirm=()=>false;form.dispatchEvent(new Event('submit',{cancelable:true}));await tick();
    assert.equal(x.queuedCreates.length,1);assert.equal(x.nodes.get('new-title').value,'fixture same');
    x.win.confirm=()=>true;form.dispatchEvent(new Event('submit',{cancelable:true}));await until(()=>x.queuedCreates.length===2);
    assert.notEqual(JSON.parse(x.queuedCreates[1].body).id,first.id);
  } finally {
    for(const request of x.queuedCreates)request.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});


test('an uncertain create keeps later edits and identifies the sent content',async t=>{
  const x=await setup(t,{initialId:ownerA,persistBeforePostResponse:true});
  x.deferPost=true;
  x.nodes.get('new-title').value='fixture new title';x.nodes.get('new-body').value='fixture new body';
  x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
  await until(()=>x.postCalls===1&&x.persisted);
  x.nodes.get('new-title').value='later edit';x.nodes.get('new-title').dispatchEvent(new Event('input'));
  x.post.reject(Error('synthetic connection failure'));
  await until(()=>!x.nodes.get('draft-warning').hidden);
  assert.match(x.nodes.get('draft-warning').textContent,/전송한 내용.*저장.*확인/);
  assert.equal(x.nodes.get('new-title').value,'later edit');
  assert.equal(x.nodes.get('new-body').value,'fixture new body');
});

function descendants(node,tag){
  return [node,...node.children.flatMap(child=>descendants(child,tag))].filter(item=>item.tagName===tag.toUpperCase());
}
function existingFields(x){
  const notes=x.nodes.get('notes');
  const inputs=descendants(notes,'input'),bodies=descendants(notes,'textarea');
  assert.equal(inputs.length,1,'one synthetic existing note title should be visible');
  assert.equal(bodies.length,1,'one synthetic existing note body should be visible');
  return {title:inputs[0],body:bodies[0]};
}
function editExisting(x,title,body){
  const fields=existingFields(x);
  fields.title.value=title;fields.title.dispatchEvent(new Event('input'));
  fields.body.value=body;fields.body.dispatchEvent(new Event('input'));
}
async function waitExisting(x,minimumReads=2){
  await until(()=>x.notesReads>=minimumReads&&x.nodes.get('notes').children.length===1);
  return existingFields(x);
}

test('an existing note edit survives logout and same owner verified reauthentication',async t=>{
  const x=await setup(t,{initialId:ownerA,loginId:ownerA});
  editExisting(x,'fixture edited title','fixture edited body');
  x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);
  assert.equal(x.nodes.get('notes').children.length,0,'locked vault must not display edited content');
  await loginAndVerify(x);const fields=await waitExisting(x);
  assert.equal(fields.title.value,'fixture edited title');
  assert.equal(fields.body.value,'fixture edited body');
  assert.equal(x.postCalls,0,'recovery must not silently write to the server');
});

test('an existing note draft never appears to another owner with the same note ID',async t=>{
  const x=await setup(t,{initialId:ownerA,loginId:ownerB});
  editExisting(x,'fixture owner-a edit','fixture owner-a body');
  x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);
  x.serverNotes=[{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',title:'fixture owner-b title',body:'fixture owner-b body'}];
  await loginAndVerify(x);const other=await waitExisting(x);
  assert.equal(other.title.value,'fixture owner-b title');
  assert.equal(other.body.value,'fixture owner-b body');
  assert.ok(visibleValues(x).every(text=>!text.includes('fixture owner-a edit')&&!text.includes('fixture owner-a body')),
    'the other owner must not see retained edit content in any workspace notice');
  x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);
  x.loginId=ownerA;x.serverNotes=[{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',title:'fixture',body:'fixture'}];
  await loginAndVerify(x);const restored=await waitExisting(x,3);
  assert.equal(restored.title.value,'fixture owner-a edit');
  assert.equal(restored.body.value,'fixture owner-a body');
  assert.equal(x.postCalls,0);
});

test('empty existing note edits remain empty after same owner reauthentication',async t=>{
  const x=await setup(t,{initialId:ownerA,loginId:ownerA});
  editExisting(x,'','');
  x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);
  await loginAndVerify(x);const fields=await waitExisting(x);
  assert.equal(fields.title.value,'');
  assert.equal(fields.body.value,'');
  assert.equal(x.postCalls,0);
});

test('existing note edits survive a same-session list refresh',async t=>{
  const x=await setup(t,{initialId:ownerA,loginId:ownerA});
  editExisting(x,'fixture edited title','fixture edited body');
  x.deferPost=true;
  x.nodes.get('new-title').value='another fixture';x.nodes.get('new-body').value='another body';
  x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
  await until(()=>x.postCalls===1);x.post.resolve(reply({id:x.lastCreateId},201));
  const fields=await waitExisting(x);
  assert.equal(fields.title.value,'fixture edited title');
  assert.equal(fields.body.value,'fixture edited body');
});

test('later edits made during an in-flight PUT are retained after its successful response',async t=>{
  const x=await setup(t,{initialId:ownerA,loginId:ownerA});x.queueWrites=true;
  editExisting(x,'fixture submitted title','fixture submitted body');
  const save=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='수정 저장');
  assert.ok(save);save.dispatchEvent(new Event('click'));
  await until(()=>x.queuedWrites.length===1);
  try {
    editExisting(x,'fixture later title','fixture later body');
    x.serverNotes=[{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',title:'fixture submitted title',body:'fixture submitted body'}];
    x.queuedWrites[0].resolve(reply({id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',title:'fixture submitted title',body:'fixture submitted body'}));
    const fields=await waitExisting(x);
    assert.equal(fields.title.value,'fixture later title');
    assert.equal(fields.body.value,'fixture later body');
    assert.equal(x.postCalls,1);
  } finally {for(const pending of x.queuedWrites)pending.resolve(reply({error:'FIXTURE'},500));}
});

function visibleValues(x){
  const values=[];
  const visit=node=>{
    if(node.hidden)return;
    if(typeof node.textContent==='string'&&node.textContent)values.push(node.textContent);
    if(typeof node.value==='string'&&node.value)values.push(node.value);
    for(const child of node.children)visit(child);
  };
  // Only inspect regions actually visible in the open workspace; the fake DOM
  // does not model parent visibility for the separate login panel.
for(const key of ['notes','workspace-status','draft-warning','save-operation-status','save-uncertainty-state'])visit(x.nodes.get(key));
  return values;
}

test('a changed server note and its retained local edit remain available without an automatic write',async t=>{
  const x=await setup(t,{initialId:ownerA,loginId:ownerA});
  editExisting(x,'fixture local edit','fixture local body');
  x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);
  x.serverNotes=[{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',title:'fixture server changed',body:'fixture server body'}];
  await loginAndVerify(x);await until(()=>x.notesReads>=2);await tick();
  const values=visibleValues(x);
  assert.ok(values.some(text=>text.includes('fixture local edit')),'local changes must remain available');
  assert.ok(values.some(text=>text.includes('fixture server changed')),'the latest server value must remain available for comparison');
  assert.ok(values.some(text=>/(서버|원본).*(변경|달라|다른|충돌)|(변경|달라|다른|충돌).*(서버|원본)/u.test(text)),
    'the conflict needs a visible explanation');
  assert.equal(x.postCalls,0,'recovery must not write over the changed note');
});

test('a changed server note requires explicit user confirmation before applying the retained edit',async t=>{
  const x=await setup(t,{initialId:ownerA,loginId:ownerA});x.queueWrites=true;
  editExisting(x,'fixture local edit','fixture local body');
  x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);
  x.serverNotes=[{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',title:'fixture server changed',body:'fixture server body'}];
  await loginAndVerify(x);await until(()=>x.notesReads>=2);await tick();
  const buttons=descendants(x.nodes.get('notes'),'button');
  const save=buttons.find(button=>button.textContent==='수정 저장');
  const approve=buttons.find(button=>/서버.*확인.*수정.*허용/u.test(button.textContent));
  assert.ok(save);assert.ok(approve,'the user needs an explicit comparison action');
  try {
    save.dispatchEvent(new Event('click'));await tick();
    assert.equal(x.queuedWrites.length,0,'conflicting data must not be sent without approval');
    x.win.confirm=()=>false;approve.dispatchEvent(new Event('click'));save.dispatchEvent(new Event('click'));await tick();
    assert.equal(x.queuedWrites.length,0,'cancelling confirmation must not enable a write');
    x.win.confirm=()=>true;approve.dispatchEvent(new Event('click'));save.dispatchEvent(new Event('click'));
    await until(()=>x.queuedWrites.length===1);
  } finally {
    for(const pending of x.queuedWrites)pending.resolve(reply({error:'FIXTURE'},400));
    await tick();await tick();
  }
});

test('a user can explicitly keep the changed server note and discard the retained edit',async t=>{
  const x=await setup(t,{initialId:ownerA,loginId:ownerA});
  editExisting(x,'fixture local edit','fixture local body');
  x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);
  x.serverNotes=[{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',title:'fixture server changed',body:'fixture server body'}];
  await loginAndVerify(x);await until(()=>x.notesReads>=2);await tick();
  const discard=descendants(x.nodes.get('notes'),'button').find(button=>/서버.*유지.*수정.*버리/u.test(button.textContent));
  assert.ok(discard,'the user needs a visible way to keep the server version');
  x.win.confirm=()=>false;discard.dispatchEvent(new Event('click'));await tick();
  assert.ok(visibleValues(x).some(text=>text.includes('fixture local edit')),'cancelling must retain the edit');
  x.win.confirm=()=>true;discard.dispatchEvent(new Event('click'));await tick();
  assert.ok(visibleValues(x).some(text=>text.includes('fixture server changed')));
  assert.ok(visibleValues(x).every(text=>!text.includes('fixture local edit')),'the discarded edit should no longer be displayed');
  assert.equal(x.postCalls,0,'discarding a local edit must not write the server note');
});

test('discard confirmation explains that an uncertain earlier save may still change the server',async t=>{
  const x=await setup(t,{initialId:ownerA});x.queueWrites=true;
  editExisting(x,'fixture local edit','fixture local body');
  const save=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='수정 저장');
  let confirmation='';
  try {
    save.dispatchEvent(new Event('click'));await until(()=>x.queuedWrites.length===1);
    x.queuedWrites[0].reject(Error('synthetic interrupted response'));
    await until(()=>x.notesReads>=2&&descendants(x.nodes.get('notes'),'button').some(item=>/서버.*유지.*수정.*버리/u.test(item.textContent)));
    const discard=descendants(x.nodes.get('notes'),'button').find(item=>/서버.*유지.*수정.*버리/u.test(item.textContent));
    x.win.confirm=message=>{confirmation=message;return false;};
    discard.dispatchEvent(new Event('click'));await tick();
    assert.match(confirmation,/이전 요청/);
    assert.match(confirmation,/나중|늦/);
    assert.ok(visibleValues(x).some(text=>text.includes('fixture local edit')),'cancelling must retain the edit');
    assert.equal(x.queuedWrites.length,1);
    x.win.confirm=()=>true;discard.dispatchEvent(new Event('click'));
    await until(()=>x.notesReads>=3);await tick();
    assert.match(x.nodes.get('workspace-status').textContent,/이전 요청.*나중/);
    assert.ok(visibleValues(x).every(text=>!text.includes('fixture local edit')),'confirmed discard removes the local edit');
    assert.equal(x.queuedWrites.length,1,'discarding must not send another write');
  } finally {
    for(const write of x.queuedWrites)write.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

test('discard confirmation does not claim an unresolved request for a plain server conflict',async t=>{
  const x=await setup(t,{initialId:ownerA,loginId:ownerA});
  editExisting(x,'fixture local edit','fixture local body');
  x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);
  x.serverNotes=[{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',title:'fixture server changed',body:'fixture server body'}];
  await loginAndVerify(x);await until(()=>x.notesReads>=2);await tick();
  const discard=descendants(x.nodes.get('notes'),'button').find(item=>/서버.*유지.*수정.*버리/u.test(item.textContent));
  assert.ok(discard);let confirmation='';x.win.confirm=message=>{confirmation=message;return false;};
  discard.dispatchEvent(new Event('click'));await tick();
  assert.doesNotMatch(confirmation,/이전 요청/);
  assert.ok(visibleValues(x).some(text=>text.includes('fixture local edit')));
});

test('an edited note deleted on the server remains available without being recreated automatically',async t=>{
  const x=await setup(t,{initialId:ownerA,loginId:ownerA});
  editExisting(x,'fixture deleted edit','fixture deleted body');
  x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);
  x.serverNotes=[];
  await loginAndVerify(x);await until(()=>x.notesReads>=2);await tick();
  const values=visibleValues(x);
  assert.ok(values.some(text=>text.includes('fixture deleted edit')),'the local edit must remain available');
  assert.ok(values.some(text=>/(삭제|찾을 수 없|목록에 없|없어진)/u.test(text)),
    'the missing server note needs a visible explanation');
  const discard=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='보관한 수정 버리기');
  let confirmation='';x.win.confirm=message=>{confirmation=message;return false;};
  discard.dispatchEvent(new Event('click'));await tick();
  assert.doesNotMatch(confirmation,/이전 요청/,'an ordinary retained edit must not claim an uncertain save');
  assert.ok(visibleValues(x).some(text=>text.includes('fixture deleted edit')),'cancelling retains the edit');
  assert.equal(x.postCalls,0,'recovery must not automatically recreate a deleted note');
});

test('discarding an unavailable uncertain edit warns that its earlier request may still apply',async t=>{
  const x=await setup(t,{initialId:ownerA,emptyNotes:true});x.queueWrites=true;
  editExisting(x,'fixture local edit','fixture local body');
  const save=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='수정 저장');
  try {
    save.dispatchEvent(new Event('click'));await until(()=>x.queuedWrites.length===1);
    x.queuedWrites[0].reject(Error('synthetic interrupted response'));
    await until(()=>x.notesReads>=2&&descendants(x.nodes.get('notes'),'button').some(item=>item.textContent==='보관한 수정 버리기'));
    const discard=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='보관한 수정 버리기');
    let confirmation='';x.win.confirm=message=>{confirmation=message;return false;};
    discard.dispatchEvent(new Event('click'));await tick();
    assert.match(confirmation,/이전 요청.*나중/);
    assert.ok(visibleValues(x).some(text=>text.includes('fixture local edit')),'cancelling retains the edit');
    x.win.confirm=()=>true;discard.dispatchEvent(new Event('click'));await tick();
    assert.match(x.nodes.get('workspace-status').textContent,/이전 요청.*나중/);
    assert.equal(x.queuedWrites.length,1,'discarding must not send another write');
  } finally {
    for(const write of x.queuedWrites)write.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

test('an unavailable edit with an in-flight save also warns before discarding',async t=>{
  const x=await setup(t,{initialId:ownerA,loginId:ownerA});x.queueWrites=true;
  editExisting(x,'fixture local edit','fixture local body');
  const save=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='수정 저장');
  try {
    save.dispatchEvent(new Event('click'));await until(()=>x.queuedWrites.length===1);
    x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);
    x.serverNotes=[];await loginAndVerify(x);await until(()=>x.notesReads>=2);await tick();
    const discard=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='보관한 수정 버리기');
    assert.ok(discard);let confirmation='';x.win.confirm=message=>{confirmation=message;return false;};
    discard.dispatchEvent(new Event('click'));await tick();
    assert.match(confirmation,/이전 요청.*나중/);
    assert.ok(visibleValues(x).some(text=>text.includes('fixture local edit')));
    assert.equal(x.queuedWrites.length,1);
  } finally {
    for(const write of x.queuedWrites)write.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

test('an invalid note ID is not used to silently attach an edit to a server record',async t=>{
  const x=await setup(t,{initialId:ownerA,loginId:ownerA,
    initialNotes:[{id:'invalid-note-id',title:'fixture base',body:'fixture base body'}]});
  editExisting(x,'fixture unbound edit','fixture unbound body');
  x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);
  x.serverNotes=[{id:'invalid-note-id',title:'fixture server base',body:'fixture server body'}];
  await loginAndVerify(x);await until(()=>x.notesReads>=2);await tick();
  const fields=descendants(x.nodes.get('notes'),'input');
  assert.ok(fields.every(field=>field.value!=='fixture unbound edit'||field.readOnly||field.disabled),
    'invalid IDs must not receive an automatically editable draft');
  const values=visibleValues(x);
  assert.ok(values.some(text=>text.includes('fixture unbound edit')),'the unbound edit remains available for manual handling');
  assert.ok(values.some(text=>/(식별|연결|복구).*(불가|확인|수 없)|(불가|확인|수 없).*(식별|연결|복구)/u.test(text)));
  assert.equal(x.postCalls,0);
});

test('duplicate note IDs do not silently apply an edit to either server record',async t=>{
  const duplicate='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const x=await setup(t,{initialId:ownerA,loginId:ownerA,initialNotes:[
    {id:duplicate,title:'fixture duplicate one',body:'fixture body one'},
    {id:duplicate,title:'fixture duplicate two',body:'fixture body two'},
  ]});
  const inputs=descendants(x.nodes.get('notes'),'input'),bodies=descendants(x.nodes.get('notes'),'textarea');
  assert.equal(inputs.length,2);assert.equal(bodies.length,2);
  inputs[0].value='fixture ambiguous edit';inputs[0].dispatchEvent(new Event('input'));
  bodies[0].value='fixture ambiguous body';bodies[0].dispatchEvent(new Event('input'));
  x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);
  await loginAndVerify(x);await until(()=>x.notesReads>=2);await tick();
  const inputsAfter=descendants(x.nodes.get('notes'),'input');
  assert.ok(inputsAfter.every(field=>field.value!=='fixture ambiguous edit'||field.readOnly||field.disabled),
    'ambiguous IDs must not receive an automatically editable draft');
  const values=visibleValues(x);
  assert.ok(values.some(text=>text.includes('fixture ambiguous edit')),'the edit remains available separately');
  assert.ok(values.some(text=>/(중복|식별|일치).*(불가|확인|수 없)|(불가|확인|수 없).*(중복|식별|일치)/u.test(text)));
  assert.equal(x.postCalls,0);
});

test('a failed notes list does not hide the local-edit retention notice',async t=>{
  const x=await setup(t,{initialId:ownerA,loginId:ownerA,notesFailure:'network'});
  editExisting(x,'fixture retained edit','fixture retained body');
  x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);
  await loginAndVerify(x);await until(()=>x.notesReads>=2);await tick();
  assert.ok(visibleValues(x).some(text=>/(작성|편집|수정).*(보관|복구)|(보관|복구).*(작성|편집|수정)/u.test(text)),
    'list failure must not erase the retention notice');
  assert.equal(x.postCalls,0);
});

for(const outcome of ['network','server']){
  test(`an uncertain existing-note save (${outcome}) retains the edit and asks for verification`,async t=>{
    const x=await setup(t,{initialId:ownerA,loginId:ownerA});x.queueWrites=true;
    editExisting(x,'fixture submitted edit','fixture submitted body');
    const save=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='수정 저장');
    assert.ok(save);save.dispatchEvent(new Event('click'));
    await until(()=>x.queuedWrites.length===1);
    if(outcome==='network')x.queuedWrites[0].reject(Error('synthetic network failure'));
    else x.queuedWrites[0].resolve(reply({error:'SYNTHETIC_FAILURE'},500));
    await until(()=>x.nodes.get('workspace-status').textContent.includes(outcome==='network'?'network':'SYNTHETIC_FAILURE'));
    const fields=existingFields(x);
    assert.equal(fields.title.value,'fixture submitted edit');assert.equal(fields.body.value,'fixture submitted body');
    assert.ok(visibleValues(x).some(text=>/저장.{0,80}(여부|확인)/u.test(text)),
      'a possibly committed PUT requires a visible verification notice');
    assert.equal(x.postCalls,1);
  });
}

test('an aborted existing-note PUT keeps its edit and uncertainty after reauthentication',async t=>{
  const x=await setup(t,{initialId:ownerA,loginId:ownerA});x.queueWrites=true;
  editExisting(x,'fixture timed edit','fixture timed body');
  const save=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='수정 저장');
  assert.ok(save);save.dispatchEvent(new Event('click'));
  await until(()=>x.queuedWrites.length===1);
  x.queuedWrites[0].reject(new DOMException('synthetic timeout','AbortError'));
  await until(()=>x.nodes.get('workspace-status').textContent.includes('timeout'));
  x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);
  await loginAndVerify(x);await until(()=>x.notesReads>=2);await tick();
  const values=visibleValues(x);
  assert.ok(values.some(text=>text.includes('fixture timed edit')),'the local edit must remain available');
  assert.ok(values.some(text=>/저장.{0,80}(여부|확인)/u.test(text)),
    'the aborted request must retain its uncertainty notice');
  assert.equal(x.postCalls,1,'recovery must not replay the timed-out PUT');
});

for(const laterEdits of [false,true]) test(`a successful retry still reports an earlier uncertain save (${laterEdits?'later edits':'no later edits'})`,async t=>{
  const x=await setup(t,{initialId:ownerA});x.queueWrites=true;
  editExisting(x,'fixture local edit','fixture local body');
  let save=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='수정 저장');
  try {
    save.dispatchEvent(new Event('click'));await until(()=>x.queuedWrites.length===1);
    x.queuedWrites[0].reject(Error('synthetic interrupted response'));
    await until(()=>x.notesReads>=2&&descendants(x.nodes.get('notes'),'button').some(item=>/서버.*확인.*수정.*허용/u.test(item.textContent)));
    let buttons=descendants(x.nodes.get('notes'),'button');
    buttons.find(item=>/서버.*확인.*수정.*허용/u.test(item.textContent)).dispatchEvent(new Event('click'));
    save=buttons.find(item=>item.textContent==='수정 저장');save.dispatchEvent(new Event('click'));
    await until(()=>x.queuedWrites.length===2);
    if(laterEdits)editExisting(x,'fixture later edit','fixture later body');
    x.queuedWrites[1].resolve(reply({ok:true},200));
    await until(()=>x.notesReads>=3);await tick();
    const status=x.nodes.get('workspace-status').textContent;
    assert.match(status,/이전 요청/,'the earlier unresolved request must remain visible');
    assert.match(status,/나중|늦/,'the user must be told the earlier write can arrive later');
    if(laterEdits){
      assert.match(status,/이후.*(수정|작성)/);
      assert.equal(existingFields(x).title.value,'fixture later edit');
    }
  } finally {
    for(const write of x.queuedWrites)write.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

test('a confirmed save without an earlier uncertain request has no uncertainty warning',async t=>{
  const x=await setup(t,{initialId:ownerA});x.queueWrites=true;
  editExisting(x,'fixture saved title','fixture saved body');
  const save=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='수정 저장');
  try {
    save.dispatchEvent(new Event('click'));await until(()=>x.queuedWrites.length===1);
    x.serverNotes=[{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',title:'fixture saved title',body:'fixture saved body'}];
    x.queuedWrites[0].resolve(reply({ok:true},200));
    await until(()=>x.notesReads>=2);await tick();
    assert.equal(x.nodes.get('workspace-status').textContent,'수정했습니다.');
    assert.equal(x.queuedWrites.length,1);
  } finally {
    for(const write of x.queuedWrites)write.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

test('a pending note save keeps focus while suppressing duplicate writes',async t=>{
  const x=await setup(t,{delayRefresh:true,initialId:ownerA});x.queueWrites=true;
  editExisting(x,'fixture submitted title','fixture submitted body');
  const save=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='수정 저장');
  const heading=x.nodes.get('vault-title');
  assert.ok(save);
  x.doc.body={};x.doc.activeElement=save;x.win.innerHeight=720;
  x.nodes.get('workspace').contains=element=>element===save;
  heading.focus=()=>{x.doc.activeElement=heading;};
  heading.getBoundingClientRect=()=>({top:10,bottom:30});
  let nativeDisabled=save.disabled;
  Object.defineProperty(save,'disabled',{configurable:true,get:()=>nativeDisabled,set:value=>{
    nativeDisabled=value;if(value&&x.doc.activeElement===save)x.doc.activeElement=x.doc.body;
  }});
  try {
    save.dispatchEvent(new Event('click'));await until(()=>x.queuedWrites.length===1);
    assert.equal(save.disabled,false,'a pending save must retain a focusable native button');
    assert.equal(save.getAttribute('aria-disabled'),'true');
    assert.equal(x.doc.activeElement,save);
    save.dispatchEvent(new Event('click'));await tick();
    assert.equal(x.queuedWrites.length,1,'a repeated activation must not send another write');
    x.queuedWrites[0].resolve(reply({error:'UNAUTHORIZED'},401));
    await until(()=>x.sessionCalls===2);await tick();
    assert.equal(x.doc.activeElement,heading,'a rejected save must leave focus near the locked vault');
  } finally {
    for(const write of x.queuedWrites)write.resolve(reply({error:'UNAUTHORIZED'},401));
    x.refresh.resolve(reply({error:'UNAUTHORIZED'},401));
  }
});

test('an uncertain save returns focus to the editable note after its list reloads',async t=>{
  const x=await setup(t,{initialId:ownerA});x.queueWrites=true;
  editExisting(x,'fixture edited title','fixture edited body');
  const oldTitle=existingFields(x).title;
  const save=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='수정 저장');
  assert.ok(save);x.doc.body={};x.doc.activeElement=save;
  try {
    save.dispatchEvent(new Event('click'));await until(()=>x.queuedWrites.length===1);
    x.queuedWrites[0].resolve(reply({error:'SYNTHETIC_FAILURE'},503));
    await until(()=>x.notesReads>=2&&existingFields(x).title!==oldTitle);
    await tick();
    const title=existingFields(x).title;
    assert.equal(x.doc.activeElement,title,'focus must remain on the affected editable note');
    assert.equal(title.value,'fixture edited title');
    assert.ok(descendants(x.nodes.get('notes'),'button').some(item=>/서버.*확인.*수정.*허용/u.test(item.textContent)));
  } finally {for(const write of x.queuedWrites)write.resolve(reply({error:'UNAUTHORIZED'},401));}
});

test('an uncertain save keeps focus and blocks retries while the list is delayed',async t=>{
  const x=await setup(t,{initialId:ownerA,delayNotesRead:true});x.queueWrites=true;
  editExisting(x,'fixture edited title','fixture edited body');
  const oldTitle=existingFields(x).title;
  const save=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='수정 저장');
  assert.ok(save);x.doc.body={};x.doc.activeElement=save;x.win.innerHeight=720;
  try {
    save.dispatchEvent(new Event('click'));await until(()=>x.queuedWrites.length===1);
    x.queuedWrites[0].resolve(reply({error:'SYNTHETIC_FAILURE'},503));
    await until(()=>x.notesReads===2);
    assert.equal(save.disabled,false,'the current save must remain focusable until the list is shown');
    assert.equal(save.getAttribute('aria-disabled'),'true');
    assert.equal(x.doc.activeElement,save);
    save.dispatchEvent(new Event('click'));await tick();
    assert.equal(x.queuedWrites.length,1,'the uncertain save must not be sent again');
    x.notesRead.resolve(reply([{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',title:'fixture',body:'fixture'}]));
    await until(()=>existingFields(x).title!==oldTitle);await tick();
    assert.equal(x.doc.activeElement,existingFields(x).title);
    assert.equal(existingFields(x).title.value,'fixture edited title');
  } finally {
    x.notesRead.resolve(reply([]));
    for(const write of x.queuedWrites)write.resolve(reply({error:'UNAUTHORIZED'},401));
  }
});

test('a failed note list moves focus to the vault heading while retaining the edit',async t=>{
  const x=await setup(t,{initialId:ownerA,notesFailure:'server'});x.queueWrites=true;
  editExisting(x,'fixture local edit','fixture local body');
  const notes=x.nodes.get('notes'),heading=x.nodes.get('vault-title');
  const save=descendants(notes,'button').find(item=>item.textContent==='수정 저장');
  assert.ok(save);x.doc.body={};x.doc.activeElement=save;x.win.innerHeight=720;
  notes.contains=element=>element===save;
  heading.focus=()=>{x.doc.activeElement=heading;};
  try {
    save.dispatchEvent(new Event('click'));await until(()=>x.queuedWrites.length===1);
    x.queuedWrites[0].resolve(reply({error:'SYNTHETIC_FAILURE'},503));
    await until(()=>x.notesReads===2&&notes.children.length===0);await tick();
    assert.equal(x.doc.activeElement,heading,'focus must remain near the vault after the list disappears');
    assert.match(x.nodes.get('workspace-status').textContent,/보관/);
    x.click('device-refresh');await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
    x.click('device-unlock');await until(()=>x.notesReads>=3&&notes.children.length>0);
    assert.ok(visibleValues(x).some(text=>text.includes('fixture local edit')),'the edit must remain available after reauthentication');
    assert.equal(x.queuedWrites.length,1,'reauthentication must not replay the save');
  } finally {for(const write of x.queuedWrites)write.resolve(reply({error:'SYNTHETIC_REJECTION'},400));}
});

test('uncertain conflict cannot reuse an old approval while the latest list is delayed',async t=>{
  const x=await setup(t,{initialId:ownerA,loginId:ownerA,delayNotesRead:3});x.queueWrites=true;
  editExisting(x,'fixture local edit','fixture local body');
  x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);
  const latest=[{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',title:'fixture server changed',body:'fixture server body'}];
  x.serverNotes=latest;
  await loginAndVerify(x);await until(()=>x.notesReads>=2);await tick();
  const buttons=descendants(x.nodes.get('notes'),'button');
  const save=buttons.find(item=>item.textContent==='수정 저장');
  const approve=buttons.find(item=>/서버.*확인.*수정.*허용/u.test(item.textContent));
  const discard=buttons.find(item=>/서버.*유지.*수정.*버리/u.test(item.textContent));
  assert.ok(save&&approve&&discard);
  try {
    approve.dispatchEvent(new Event('click'));save.dispatchEvent(new Event('click'));
    await until(()=>x.queuedWrites.length===1);
    x.queuedWrites[0].resolve(reply({error:'SYNTHETIC_FAILURE'},503));
    await until(()=>x.notesReads===3);
    assert.equal(approve.disabled,true,'an old approval must be unavailable until the latest list arrives');
    assert.equal(discard.disabled,true,'discard must wait for the latest list too');
    approve.dispatchEvent(new Event('click'));discard.dispatchEvent(new Event('click'));save.dispatchEvent(new Event('click'));
    await tick();
    assert.equal(x.queuedWrites.length,1,'forced activation must not send an unreviewed write');
    assert.ok(visibleValues(x).some(text=>text.includes('fixture local edit')),'the local edit must remain available');
    x.notesRead.resolve(reply(latest));
    await until(()=>descendants(x.nodes.get('notes'),'button').some(item=>item!==approve&&/서버.*확인.*수정.*허용/u.test(item.textContent)));
    const current=descendants(x.nodes.get('notes'),'button');
    const newApprove=current.find(item=>/서버.*확인.*수정.*허용/u.test(item.textContent));
    const newSave=current.find(item=>item.textContent==='수정 저장');
    newApprove.dispatchEvent(new Event('click'));newSave.dispatchEvent(new Event('click'));
    await until(()=>x.queuedWrites.length===2);
  } finally {
    x.notesRead.resolve(reply([]));
    for(const write of x.queuedWrites)write.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

for(const status of [200,503]) test(`a late ${status} save after reauthentication requires a fresh list before review`,async t=>{
  const x=await setup(t,{initialId:ownerA,loginId:ownerA,delayNotesRead:3});x.queueWrites=true;
  editExisting(x,'fixture local edit','fixture local body');
  const oldSave=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='수정 저장');
  oldSave.dispatchEvent(new Event('click'));await until(()=>x.queuedWrites.length===1);
  x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);
  await loginAndVerify(x);await until(()=>x.notesReads>=2);await tick();
  const buttons=descendants(x.nodes.get('notes'),'button');
  const save=buttons.find(item=>item.textContent==='수정 저장');
  const approve=buttons.find(item=>/서버.*확인.*수정.*허용/u.test(item.textContent));
  const discard=buttons.find(item=>/서버.*유지.*수정.*버리/u.test(item.textContent));
  assert.ok(save&&approve&&discard);
  try {
    assert.equal(approve.disabled,true,'a write still in flight must block review');
    x.queuedWrites[0].resolve(reply(status===200?{ok:true}:{error:'SYNTHETIC_FAILURE'},status));
    await until(()=>x.notesReads===3);
    assert.equal(approve.disabled,true,'a stale response must not enable review before a fresh list');
    assert.equal(discard.disabled,true);
    approve.dispatchEvent(new Event('click'));discard.dispatchEvent(new Event('click'));save.dispatchEvent(new Event('click'));
    await tick();
    assert.equal(x.queuedWrites.length,1,'forced activation must not send another write');
    assert.ok(visibleValues(x).some(text=>text.includes('fixture local edit')));
    x.notesRead.resolve(reply([{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',title:'fixture',body:'fixture'}]));
    await until(()=>descendants(x.nodes.get('notes'),'button').some(item=>item!==approve&&/서버.*확인.*수정.*허용/u.test(item.textContent)));
    const current=descendants(x.nodes.get('notes'),'button');
    current.find(item=>/서버.*확인.*수정.*허용/u.test(item.textContent)).dispatchEvent(new Event('click'));
    current.find(item=>item.textContent==='수정 저장').dispatchEvent(new Event('click'));
    await until(()=>x.queuedWrites.length===2);
  } finally {
    x.notesRead.resolve(reply([]));
    for(const write of x.queuedWrites)write.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

test('concurrent PUTs are suppressed or retain uncertainty when one remains in flight',async t=>{
  const x=await setup(t,{initialId:ownerA,loginId:ownerA});x.queueWrites=true;
  editExisting(x,'fixture concurrent edit','fixture concurrent body');
  const save=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='수정 저장');
  assert.ok(save);
  try {
    save.dispatchEvent(new Event('click'));save.dispatchEvent(new Event('click'));
    await until(()=>x.queuedWrites.length>=1);await tick();await tick();
    if(x.queuedWrites.length===1){
      x.queuedWrites[0].resolve(reply({error:'INVALID_NOTE'},400));
      await until(()=>x.nodes.get('workspace-status').textContent.includes('INVALID_NOTE'));
      assert.equal(x.postCalls,1,'the duplicate request was not sent');
      return;
    }
    assert.equal(x.queuedWrites.length,2);
    x.queuedWrites[0].resolve(reply({error:'INVALID_NOTE'},400));
    await until(()=>x.nodes.get('workspace-status').textContent.includes('INVALID_NOTE'));
    x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);
    await loginAndVerify(x);await until(()=>x.notesReads>=2);await tick();
    assert.ok(visibleValues(x).some(text=>/저장.{0,80}(여부|확인)/u.test(text)),
      'the still-pending PUT must retain the uncertainty notice');
    assert.equal(x.postCalls,2,'recovery must not replay either PUT');
  } finally {for(const pending of x.queuedWrites)pending.resolve(reply({ok:true},200));}
});

test('a detached old note editor cannot send a write as a newer account',async t=>{
  const x=await setup(t,{initialId:ownerA,loginId:ownerB});x.queueWrites=true;
  const staleSave=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='수정 저장');
  assert.ok(staleSave);
  x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);
  x.serverNotes=[{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',title:'fixture owner-b title',body:'fixture owner-b body'}];
  await loginAndVerify(x);await until(()=>x.notesReads>=2);await tick();
  try {
    staleSave.dispatchEvent(new Event('click'));await tick();await tick();
    assert.equal(x.queuedWrites.length,0,'a detached editor must not act with the newer account token');
    assert.equal(existingFields(x).title.value,'fixture owner-b title');
  } finally {for(const pending of x.queuedWrites)pending.resolve(reply({error:'FORBIDDEN'},403));}
});

test('a prior account’s delayed delete response cannot alter the newer account view',async t=>{
  const x=await setup(t,{initialId:ownerA,loginId:ownerB});x.queueWrites=true;
  const remove=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='삭제');
  assert.ok(remove);remove.dispatchEvent(new Event('click'));
  await until(()=>x.queuedWrites.length===1);
  try {
    x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);
    x.serverNotes=[{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',title:'fixture owner-b title',body:'fixture owner-b body'}];
    await loginAndVerify(x);await until(()=>x.notesReads>=2);await tick();
    const reads=x.notesReads;
    x.queuedWrites[0].resolve(reply({ok:true},200));await tick();await tick();
    assert.equal(existingFields(x).title.value,'fixture owner-b title');
    assert.equal(x.notesReads,reads,'a known different owner must not be reloaded for the old deletion');
    assert.equal(x.queuedWrites.length,1,'an old response must not trigger a new write');
  } finally {x.queuedWrites[0].resolve(reply({ok:true},200));}
});

for (const firstAction of ['save','delete']) test(`an in-flight ${firstAction} excludes another mutation of the same note`,async t=>{
  const x=await setup(t,{initialId:ownerA});x.queueWrites=true;
  editExisting(x,'fixture local edit','fixture local body');
  const buttons=descendants(x.nodes.get('notes'),'button');
  const save=buttons.find(item=>item.textContent==='수정 저장');
  const remove=buttons.find(item=>item.textContent==='삭제');
  let confirmations=0;x.win.confirm=()=>{confirmations++;return true;};
  try {
    (firstAction==='save'?save:remove).dispatchEvent(new Event('click'));
    await until(()=>x.queuedWrites.length===1);
    assert.equal(remove.disabled,false,'the delete button remains focusable');
    assert.equal(remove.getAttribute('aria-disabled'),'true','assistive technology is told the action is unavailable');
    const confirmationsBefore=confirmations;
    remove.dispatchEvent(new Event('click'));save.dispatchEvent(new Event('click'));
    await tick();await tick();
    assert.equal(x.queuedWrites.length,1,'no second PUT or DELETE may be sent while a mutation is pending');
    assert.equal(confirmations,confirmationsBefore,'a blocked delete must not open a misleading confirmation');
    x.queuedWrites[0].resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await until(()=>x.nodes.get('workspace-status').textContent.includes('SYNTHETIC_REJECTION'));
    await tick();remove.dispatchEvent(new Event('click'));await until(()=>x.queuedWrites.length===2);
  } finally {
    for(const write of x.queuedWrites)write.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

test('a pending delete still excludes writes after same-owner reauthentication',async t=>{
  const x=await setup(t,{initialId:ownerA,loginId:ownerA});x.queueWrites=true;
  const oldRemove=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='삭제');
  try {
    oldRemove.dispatchEvent(new Event('click'));await until(()=>x.queuedWrites.length===1);
    x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);
    await loginAndVerify(x);await until(()=>x.notesReads>=2);await tick();
    const buttons=descendants(x.nodes.get('notes'),'button');
    const save=buttons.find(item=>item.textContent==='수정 저장');
    const remove=buttons.find(item=>item.textContent==='삭제');
    assert.equal(remove.getAttribute('aria-disabled'),'true');
    save.dispatchEvent(new Event('click'));remove.dispatchEvent(new Event('click'));await tick();
    assert.equal(x.queuedWrites.length,1);
    x.queuedWrites[0].resolve(reply({error:'SYNTHETIC_REJECTION'},400));await tick();await tick();
    assert.equal(remove.getAttribute('aria-disabled'),null);
  } finally {
    for(const write of x.queuedWrites)write.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

test('a late successful delete rechecks the same owner before unlocking the note',async t=>{
  const x=await setup(t,{initialId:ownerA,loginId:ownerA,delayNotesRead:3});x.queueWrites=true;
  const oldRemove=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='삭제');
  try {
    oldRemove.dispatchEvent(new Event('click'));await until(()=>x.queuedWrites.length===1);
    x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);
    await loginAndVerify(x);await until(()=>x.notesReads>=2);await tick();
    const buttons=descendants(x.nodes.get('notes'),'button');
    const save=buttons.find(item=>item.textContent==='수정 저장');
    const remove=buttons.find(item=>item.textContent==='삭제');
    x.queuedWrites[0].resolve(reply({ok:true},200));await until(()=>x.notesReads>=3);
    assert.equal(remove.getAttribute('aria-disabled'),'true','the fresh list must arrive before allowing a new mutation');
    save.dispatchEvent(new Event('click'));remove.dispatchEvent(new Event('click'));await tick();
    assert.equal(x.queuedWrites.length,1);
    x.notesRead.resolve(reply([]));
    await until(()=>x.nodes.get('notes').children.length===0);
    assert.equal(x.queuedWrites.length,1);
  } finally {
    x.notesRead.resolve(reply([]));
    for(const write of x.queuedWrites)write.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

test('a failed post-delete list keeps the note locked until a later successful list',async t=>{
  const x=await setup(t,{initialId:ownerA,loginId:ownerA,delayNotesRead:3});x.queueWrites=true;
  const oldRemove=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='삭제');
  try {
    oldRemove.dispatchEvent(new Event('click'));await until(()=>x.queuedWrites.length===1);
    x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);
    await loginAndVerify(x);await until(()=>x.notesReads>=2);await tick();
    const remove=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='삭제');
    x.queuedWrites[0].resolve(reply({ok:true},200));await until(()=>x.notesReads>=3);
    x.notesRead.reject(Error('synthetic list network failure'));
    await until(()=>x.nodes.get('workspace-status').textContent.includes('synthetic list network failure'));
    assert.ok(descendants(x.nodes.get('notes'),'button').includes(remove),'the old editor remains visible on a network error');
    assert.equal(remove.getAttribute('aria-disabled'),'true','a failed list cannot unlock a stale editor');
    remove.dispatchEvent(new Event('click'));await tick();assert.equal(x.queuedWrites.length,1);
    x.serverNotes=[];x.click('device-refresh');
    await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
    x.click('device-unlock');await until(()=>x.notesReads>=4&&x.nodes.get('notes').children.length===0);
  } finally {
    x.notesRead.resolve(reply([]));
    for(const write of x.queuedWrites)write.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

test('a newer successful list completes the delete status when the first list is superseded',async t=>{
  const x=await setup(t,{initialId:ownerA,delayNotesRead:2});x.queueWrites=true;
  const remove=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='삭제');
  try {
    remove.dispatchEvent(new Event('click'));await until(()=>x.queuedWrites.length===1);
    x.serverNotes=[];x.queuedWrites[0].resolve(reply({ok:true},200));await until(()=>x.notesReads===2);
    x.click('device-refresh');await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
    x.click('device-unlock');await until(()=>x.notesReads>=3&&x.nodes.get('notes').children.length===0);
    assert.equal(x.nodes.get('workspace-status').textContent,'삭제했습니다.');
  } finally {
    x.notesRead.resolve(reply([]));
    for(const write of x.queuedWrites)write.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

test('a malformed post-delete list cannot unlock the old note or lose later edits',async t=>{
  const x=await setup(t,{initialId:ownerA,loginId:ownerA,delayNotesRead:3});x.queueWrites=true;
  const oldRemove=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='삭제');
  try {
    oldRemove.dispatchEvent(new Event('click'));await until(()=>x.queuedWrites.length===1);
    x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);
    await loginAndVerify(x);await until(()=>x.notesReads>=2);await tick();
    const remove=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='삭제');
    x.queuedWrites[0].resolve(reply({ok:true},200));await until(()=>x.notesReads>=3);
    x.notesRead.resolve(reply([null]));
    await until(()=>x.nodes.get('workspace-status').textContent.includes('자료 형식'));
    assert.equal(remove.getAttribute('aria-disabled'),'true');
    editExisting(x,'fixture retained after malformed list','fixture retained body');
    x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);
    await loginAndVerify(x);await until(()=>x.notesReads>=4);await tick();
    assert.ok(visibleValues(x).some(text=>text.includes('fixture retained after malformed list')));
    assert.equal(x.queuedWrites.length,1);
  } finally {
    x.notesRead.resolve(reply([]));
    for(const write of x.queuedWrites)write.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

test('edits entered while deletion is pending remain available after a successful deletion',async t=>{
  const x=await setup(t,{initialId:ownerA});x.queueWrites=true;
  const remove=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='삭제');
  try {
    remove.dispatchEvent(new Event('click'));await until(()=>x.queuedWrites.length===1);
    editExisting(x,'fixture edit while deleting','fixture body while deleting');
    x.serverNotes=[];x.queuedWrites[0].resolve(reply({ok:true},200));
    await until(()=>x.notesReads>=2&&descendants(x.nodes.get('notes'),'button').some(item=>item.textContent==='보관한 수정 버리기'));
    assert.ok(visibleValues(x).some(text=>text.includes('fixture edit while deleting')));
    assert.equal(x.queuedWrites.length,1);
  } finally {
    for(const write of x.queuedWrites)write.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

test('a pending delete does not prevent editing another note',async t=>{
  const notes=[
    {id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',title:'fixture a',body:'fixture body a'},
    {id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',title:'fixture b',body:'fixture body b'},
  ];
  const x=await setup(t,{initialId:ownerA,initialNotes:notes});x.queueWrites=true;
  const articles=x.nodes.get('notes').children;
  const removeA=descendants(articles[0],'button').find(item=>item.textContent==='삭제');
  const saveB=descendants(articles[1],'button').find(item=>item.textContent==='수정 저장');
  try {
    removeA.dispatchEvent(new Event('click'));await until(()=>x.queuedWrites.length===1);
    saveB.dispatchEvent(new Event('click'));await until(()=>x.queuedWrites.length===2);
    assert.equal(x.queuedWrites[0].method,'DELETE');
    assert.equal(x.queuedWrites[1].method,'PUT');
  } finally {
    for(const write of x.queuedWrites)write.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

for (const outcome of ['network','server']) test(`an uncertain delete (${outcome}) keeps later mutations blocked after reauthentication`,async t=>{
  const x=await setup(t,{initialId:ownerA,loginId:ownerA});x.queueWrites=true;
  const remove=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='삭제');
  try {
    remove.dispatchEvent(new Event('click'));await until(()=>x.queuedWrites.length===1);
    if(outcome==='network')x.queuedWrites[0].reject(Error('synthetic interrupted response'));
    else x.queuedWrites[0].resolve(reply({error:'SYNTHETIC_FAILURE'},503));
    await until(()=>!x.nodes.get('delete-uncertainty-state').hidden);
    assert.match(x.nodes.get('delete-uncertainty-state').textContent,/나중.*삭제/);
    assert.match(x.nodes.get('delete-uncertainty-state').textContent,/새로고침.*탭을 닫/);
    editExisting(x,'fixture retained edit','fixture retained body');
    const save=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='수정 저장');
    save.dispatchEvent(new Event('click'));remove.dispatchEvent(new Event('click'));await tick();
    assert.equal(x.queuedWrites.length,1,'an uncertain delete must block a later PUT or DELETE');
    x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);
    await loginAndVerify(x);await until(()=>x.notesReads>=2);await tick();
    assert.equal(x.nodes.get('delete-uncertainty-state').hidden,false,'a fresh list cannot prove the deletion has finished');
    assert.equal(existingFields(x).title.value,'fixture retained edit');
    const current=descendants(x.nodes.get('notes'),'button');
    current.find(item=>item.textContent==='수정 저장').dispatchEvent(new Event('click'));
    current.find(item=>item.textContent==='삭제').dispatchEvent(new Event('click'));
    await tick();assert.equal(x.queuedWrites.length,1);
  } finally {
    for(const write of x.queuedWrites)write.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

test('an uncertain delete does not block a different owner with the same note ID',async t=>{
  const x=await setup(t,{initialId:ownerA,loginId:ownerB});x.queueWrites=true;
  const remove=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='삭제');
  try {
    remove.dispatchEvent(new Event('click'));await until(()=>x.queuedWrites.length===1);
    x.queuedWrites[0].reject(Error('synthetic interrupted response'));
    await until(()=>!x.nodes.get('delete-uncertainty-state').hidden);
    x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);
    await loginAndVerify(x);await until(()=>x.notesReads>=2);await tick();
    assert.equal(x.nodes.get('delete-uncertainty-state').hidden,true);
    const current=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='삭제');
    current.dispatchEvent(new Event('click'));await until(()=>x.queuedWrites.length===2);
  } finally {
    for(const write of x.queuedWrites)write.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

test('a timed-out delete stays blocked even after the original request later succeeds',async t=>{
  const x=await setup(t,{initialId:ownerA,captureMutationTimers:true});x.queueWrites=true;
  const remove=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='삭제');
  try {
    remove.dispatchEvent(new Event('click'));await until(()=>x.queuedWrites.length===1);
    x.fireMutationTimeout();await until(()=>!x.nodes.get('delete-uncertainty-state').hidden);
    assert.equal(x.queuedWrites[0].signal.aborted,true);
    x.queuedWrites[0].resolve(reply({ok:true},200));await tick();await tick();
    assert.equal(x.nodes.get('delete-uncertainty-state').hidden,false);
    const save=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='수정 저장');
    save.dispatchEvent(new Event('click'));remove.dispatchEvent(new Event('click'));await tick();
    assert.equal(x.queuedWrites.length,1);
  } finally {
    for(const write of x.queuedWrites)write.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

test('a delete server error blocks later writes before its response body finishes',async t=>{
  const x=await setup(t,{initialId:ownerA});x.queueWrites=true;const body=deferred();
  const remove=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='삭제');
  try {
    remove.dispatchEvent(new Event('click'));await until(()=>x.queuedWrites.length===1);
    x.queuedWrites[0].resolve({ok:false,status:503,json:()=>body.promise});
    await until(()=>!x.nodes.get('delete-uncertainty-state').hidden);
    const save=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='수정 저장');
    save.dispatchEvent(new Event('click'));remove.dispatchEvent(new Event('click'));await tick();
    assert.equal(x.queuedWrites.length,1);
  } finally {body.resolve({error:'SYNTHETIC_FAILURE'});await tick();await tick();}
});

test('the uncertain delete notice remains when its note is missing from a later list',async t=>{
  const x=await setup(t,{initialId:ownerA,loginId:ownerA});x.queueWrites=true;
  const remove=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='삭제');
  try {
    remove.dispatchEvent(new Event('click'));await until(()=>x.queuedWrites.length===1);
    x.queuedWrites[0].reject(Error('synthetic interrupted response'));
    await until(()=>!x.nodes.get('delete-uncertainty-state').hidden);
    x.serverNotes=[];x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);
    await loginAndVerify(x);await until(()=>x.notesReads>=2&&x.nodes.get('notes').children.length===0);
    assert.equal(x.nodes.get('delete-uncertainty-state').hidden,false);
    assert.match(x.nodes.get('delete-uncertainty-state').textContent,/나중.*삭제/);
  } finally {
    for(const write of x.queuedWrites)write.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

test('an unidentifiable owner is told why an uncertain delete remains conservatively blocked',async t=>{
  const x=await setup(t);x.queueWrites=true;
  const remove=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='삭제');
  try {
    remove.dispatchEvent(new Event('click'));await until(()=>x.queuedWrites.length===1);
    x.queuedWrites[0].reject(Error('synthetic interrupted response'));
    await until(()=>!x.nodes.get('delete-uncertainty-state').hidden);
    x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);
    await loginAndVerify(x);await until(()=>x.notesReads>=2);await tick();
    assert.match(x.nodes.get('delete-uncertainty-state').textContent,/계정.*식별.*확인/);
    const current=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='삭제');
    current.dispatchEvent(new Event('click'));await tick();assert.equal(x.queuedWrites.length,1);
  } finally {
    for(const write of x.queuedWrites)write.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

for (const [initialId,loginId,label] of [[undefined,ownerA,'unidentified to identified'],[ownerA,undefined,'identified to unidentified']])
for (const pending of [false,true]) test(`delete ${pending?'pending':'uncertain'} remains blocked from ${label}`,async t=>{
  const x=await setup(t,{initialId,loginId});x.queueWrites=true;
  const remove=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='삭제');
  try {
    remove.dispatchEvent(new Event('click'));await until(()=>x.queuedWrites.length===1);
    if(!pending) {
      x.queuedWrites[0].reject(Error('synthetic interrupted response'));
      await until(()=>!x.nodes.get('delete-uncertainty-state').hidden);
    }
    x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);
    await loginAndVerify(x);await until(()=>x.notesReads>=2);await tick();
    const current=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='삭제');
    assert.equal(current.getAttribute('aria-disabled'),'true');
    assert.ok(visibleValues(x).some(text=>/계정.*식별.*확인/.test(text)),
      'the blocked note must explain the owner-identity ambiguity');
    current.dispatchEvent(new Event('click'));await tick();assert.equal(x.queuedWrites.length,1);
    if(!pending)assert.match(x.nodes.get('delete-uncertainty-state').textContent,/계정.*식별.*확인/);
  } finally {
    for(const write of x.queuedWrites)write.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

for (const [initialId,loginId,label] of [[undefined,ownerA,'unidentified to identified'],[ownerA,undefined,'identified to unidentified']])
  test(`a late successful delete rechecks the current vault from ${label} without clearing its ambiguous reservation`,async t=>{
    const x=await setup(t,{initialId,loginId,delayNotesRead:3});x.queueWrites=true;
    const oldRemove=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='삭제');
    try {
      oldRemove.dispatchEvent(new Event('click'));await until(()=>x.queuedWrites.length===1);
      x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);
      await loginAndVerify(x);await until(()=>x.notesReads>=2);await tick();
      const currentRemove=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='삭제');
      x.queuedWrites[0].resolve(reply({ok:true},200));await until(()=>x.notesReads>=3);
      assert.equal(currentRemove.getAttribute('aria-disabled'),'true');
      currentRemove.dispatchEvent(new Event('click'));await tick();assert.equal(x.queuedWrites.length,1);
      x.notesRead.resolve(reply([{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',title:'fixture',body:'fixture'}]));
      await until(()=>descendants(x.nodes.get('notes'),'button').some(item=>item!==currentRemove&&item.textContent==='삭제'));
      const newRemove=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='삭제');
      assert.equal(newRemove.getAttribute('aria-disabled'),'true','an ambiguous account must not clear the original reservation');
      assert.match(x.nodes.get('workspace-status').textContent,/계정.*식별/);
      newRemove.dispatchEvent(new Event('click'));await tick();assert.equal(x.queuedWrites.length,1);
    } finally {
      x.notesRead.resolve(reply([]));
      for(const write of x.queuedWrites)write.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
      await tick();await tick();
    }
  });

test('a fresh list from a new unidentified session cannot clear an earlier unidentified delete reservation',async t=>{
  const x=await setup(t,{delayNotesRead:3});x.queueWrites=true;
  const oldRemove=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='삭제');
  try {
    oldRemove.dispatchEvent(new Event('click'));await until(()=>x.queuedWrites.length===1);
    x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);
    await loginAndVerify(x);await until(()=>x.notesReads>=2);await tick();
    x.queuedWrites[0].resolve(reply({ok:true},200));await until(()=>x.notesReads>=3);
    x.notesRead.resolve(reply([{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',title:'fixture',body:'fixture'}]));
    await tick();await tick();
    const remove=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='삭제');
    assert.equal(remove.getAttribute('aria-disabled'),'true');
    assert.match(x.nodes.get('workspace-status').textContent,/계정.*식별/);
    remove.dispatchEvent(new Event('click'));await tick();assert.equal(x.queuedWrites.length,1);
  } finally {
    x.notesRead.resolve(reply([]));
    for(const write of x.queuedWrites)write.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

test('a failed ambiguous post-delete lookup keeps the current note blocked',async t=>{
  const x=await setup(t,{initialId:ownerA,delayNotesRead:3});x.queueWrites=true;
  const oldRemove=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='삭제');
  try {
    oldRemove.dispatchEvent(new Event('click'));await until(()=>x.queuedWrites.length===1);
    x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);
    await loginAndVerify(x);await until(()=>x.notesReads>=2);await tick();
    const current=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='삭제');
    x.queuedWrites[0].resolve(reply({ok:true},200));await until(()=>x.notesReads>=3);
    x.notesRead.reject(Error('synthetic list failure'));
    await until(()=>x.nodes.get('workspace-status').textContent.includes('synthetic list failure'));
    assert.equal(current.getAttribute('aria-disabled'),'true');
    current.dispatchEvent(new Event('click'));await tick();assert.equal(x.queuedWrites.length,1);
  } finally {
    x.notesRead.resolve(reply([]));
    for(const write of x.queuedWrites)write.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

test('a successful retry replaces only its own failed ambiguous delete lookup status',async t=>{
  const x=await setup(t,{initialId:ownerA,delayNotesRead:3});x.queueWrites=true;
  const remove=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='삭제');
  try {
    remove.dispatchEvent(new Event('click'));await until(()=>x.queuedWrites.length===1);
    x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);
    await loginAndVerify(x);await until(()=>x.notesReads>=2);await tick();
    x.queuedWrites[0].resolve(reply({ok:true},200));await until(()=>x.notesReads>=3);
    x.notesRead.reject(Error('synthetic list failure'));
    await until(()=>x.nodes.get('workspace-status').textContent.includes('synthetic list failure'));
    x.click('device-refresh');await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
    x.click('device-unlock');await until(()=>x.notesReads>=4);await tick();
    assert.match(x.nodes.get('workspace-status').textContent,/목록을 다시 읽었습니다.*계정.*식별/);
    const current=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='삭제');
    assert.equal(current.getAttribute('aria-disabled'),'true');
  } finally {
    x.notesRead.resolve(reply([]));
    for(const write of x.queuedWrites)write.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

test('an earlier ambiguous delete does not overwrite a newer creation status',async t=>{
  const x=await setup(t,{loginId:ownerA,delayNotesRead:3});x.queueWrites=true;
  const remove=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='삭제');
  try {
    remove.dispatchEvent(new Event('click'));await until(()=>x.queuedWrites.length===1);
    x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);
    await loginAndVerify(x);await until(()=>x.notesReads>=2);await tick();
    x.deferPost=true;x.nodes.get('new-title').value='fixture new';x.nodes.get('new-body').value='fixture body';
    x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));await until(()=>x.postCalls===2);
    assert.equal(x.nodes.get('workspace-status').textContent,'추가 중…');
    x.queuedWrites[0].resolve(reply({ok:true},200));await until(()=>x.notesReads>=3);
    assert.equal(x.nodes.get('workspace-status').textContent,'추가 중…');
    x.notesRead.reject(Error('synthetic list failure'));await tick();await tick();
    assert.equal(x.nodes.get('workspace-status').textContent,'추가 중…','the lookup error must not overwrite the newer operation');
    assert.equal(x.nodes.get('notes-lookup-status').hidden,false,'the lookup failure must remain visible separately');
    x.click('device-refresh');await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
    x.click('device-unlock');await until(()=>x.notesReads>=4&&x.nodes.get('notes-lookup-status').hidden);
  } finally {
    x.notesRead.resolve(reply([]));x.post.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    for(const write of x.queuedWrites)write.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

for(const outcome of ['rejection','network','server']) test(`a ${outcome} delete result preserves a newer creation status and remains visible`,async t=>{
  const x=await setup(t,{initialId:ownerA});x.queueWrites=true;
  const remove=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='삭제');
  try {
    remove.dispatchEvent(new Event('click'));await until(()=>x.queuedWrites.length===1);
    x.deferPost=true;x.nodes.get('new-title').value='fixture new';x.nodes.get('new-body').value='fixture body';
    x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));await until(()=>x.postCalls===2);
    assert.equal(x.nodes.get('workspace-status').textContent,'추가 중…');
    if(outcome==='network')x.queuedWrites[0].reject(Error('synthetic disconnected'));
    else x.queuedWrites[0].resolve(reply({error:'SYNTHETIC_REJECTION'},outcome==='server'?503:400));
    await until(()=>!x.nodes.get('delete-operation-status').hidden);
    assert.equal(x.nodes.get('workspace-status').textContent,'추가 중…');
    assert.match(x.nodes.get('delete-operation-status').textContent,/삭제/);
    if(outcome!=='rejection')assert.equal(x.nodes.get('delete-uncertainty-state').hidden,false);
  } finally {
    x.post.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    for(const write of x.queuedWrites)write.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

test('a separate rejected-delete notice clears when that note is later deleted successfully',async t=>{
  const x=await setup(t,{initialId:ownerA});x.queueWrites=true;
  const remove=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='삭제');
  try {
    remove.dispatchEvent(new Event('click'));await until(()=>x.queuedWrites.length===1);
    x.deferPost=true;x.nodes.get('new-title').value='fixture new';x.nodes.get('new-body').value='fixture body';
    x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));await until(()=>x.postCalls===2);
    x.queuedWrites[0].resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await until(()=>!x.nodes.get('delete-operation-status').hidden);
    remove.dispatchEvent(new Event('click'));await until(()=>x.queuedWrites.length===2);
    x.serverNotes=[];x.queuedWrites[1].resolve(reply({ok:true},200));
    await until(()=>x.nodes.get('delete-operation-status').hidden);
  } finally {
    x.post.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    for(const write of x.queuedWrites)write.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

test('a separate delete error is cleared when the user signs out',async t=>{
  const x=await setup(t,{initialId:ownerA});x.queueWrites=true;
  const remove=descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='삭제');
  try {
    remove.dispatchEvent(new Event('click'));await until(()=>x.queuedWrites.length===1);
    x.deferPost=true;x.nodes.get('new-title').value='fixture new';x.nodes.get('new-body').value='fixture body';
    x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));await until(()=>x.postCalls===2);
    x.queuedWrites[0].resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await until(()=>!x.nodes.get('delete-operation-status').hidden);
    x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);
    assert.equal(x.nodes.get('delete-operation-status').hidden,true);
    assert.equal(x.nodes.get('delete-operation-status').textContent,'');
  } finally {
    x.post.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    for(const write of x.queuedWrites)write.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

test('separate errors for two pending deletes remain visible independently',async t=>{
  const notes=[
    {id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',title:'fixture a',body:'fixture body a'},
    {id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',title:'fixture b',body:'fixture body b'},
  ];
  const x=await setup(t,{initialId:ownerA,initialNotes:notes});x.queueWrites=true;
  const [a,b]=x.nodes.get('notes').children;
  const removeA=descendants(a,'button').find(item=>item.textContent==='삭제');
  const removeB=descendants(b,'button').find(item=>item.textContent==='삭제');
  try {
    removeA.dispatchEvent(new Event('click'));removeB.dispatchEvent(new Event('click'));
    await until(()=>x.queuedWrites.length===2);
    x.deferPost=true;x.nodes.get('new-title').value='fixture new';x.nodes.get('new-body').value='fixture body';
    x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));await until(()=>x.postCalls===3);
    x.queuedWrites[0].resolve(reply({error:'SYNTHETIC_A'},400));
    x.queuedWrites[1].resolve(reply({error:'SYNTHETIC_B'},400));
    await until(()=>!x.nodes.get('delete-operation-status').hidden);await tick();await tick();
    assert.match(x.nodes.get('delete-operation-status').textContent,/SYNTHETIC_A/);
    assert.match(x.nodes.get('delete-operation-status').textContent,/SYNTHETIC_B/);
    removeA.dispatchEvent(new Event('click'));await until(()=>x.queuedWrites.length===3);
    x.serverNotes=[notes[1]];x.queuedWrites[2].resolve(reply({ok:true},200));
    await until(()=>x.notesReads>=2);await tick();
    assert.equal(x.nodes.get('delete-operation-status').hidden,false);
    assert.doesNotMatch(x.nodes.get('delete-operation-status').textContent,/SYNTHETIC_A/);
    assert.match(x.nodes.get('delete-operation-status').textContent,/SYNTHETIC_B/);
  } finally {
    x.post.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    for(const write of x.queuedWrites)write.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

for (const outcome of ['success','rejection','server','network']) test(`an older ${outcome} save preserves a newer creation and reports its result`,async t=>{
  const x=await setup(t,{initialId:ownerA,notesFailure:'server'});x.queueWrites=true;
  try {
    editExisting(x,'fixture local edit','fixture local body');
    descendants(x.nodes.get('notes'),'button').find(b=>b.textContent==='수정 저장').dispatchEvent(new Event('click'));
    await until(()=>x.queuedWrites.length===1);
    x.deferPost=true;x.nodes.get('new-title').value='fixture new';x.nodes.get('new-body').value='fixture body';
    x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));await until(()=>x.postCalls===2);
    if(outcome==='network')x.queuedWrites[0].reject(Error('synthetic disconnected'));
    else x.queuedWrites[0].resolve(reply(outcome==='success'?{ok:true}:{error:'SYNTHETIC_FAILURE'},outcome==='success'?200:outcome==='server'?503:400));
    await until(()=>!x.nodes.get('save-operation-status').hidden);
    await tick();await tick();
    assert.equal(x.nodes.get('workspace-status').textContent,'추가 중…');
    assert.match(x.nodes.get('save-operation-status').textContent,/수정/);
    if(outcome==='server'||outcome==='network'){
      assert.equal(x.nodes.get('save-uncertainty-state').hidden,false);
      assert.match(x.nodes.get('save-uncertainty-state').textContent,/나중.*(바뀔|반영)/);
      assert.equal(x.nodes.get('notes-lookup-status').hidden,false);
    }
  } finally {
    x.post.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    for(const write of x.queuedWrites)write.resolve(reply({error:'SYNTHETIC_REJECTION'},400));
    await tick();await tick();
  }
});

test('an uncertain save warning survives list failure and a later successful list',async t=>{
  const x=await setup(t,{initialId:ownerA,notesFailure:'server'});x.queueWrites=true;
  try {
    editExisting(x,'fixture local edit','fixture local body');
    descendants(x.nodes.get('notes'),'button').find(b=>b.textContent==='수정 저장').dispatchEvent(new Event('click'));
    await until(()=>x.queuedWrites.length===1);
    x.queuedWrites[0].resolve(reply({error:'SYNTHETIC_FAILURE'},503));
    await until(()=>x.notesReads===2&&x.nodes.get('notes').children.length===0);
    assert.equal(x.nodes.get('save-uncertainty-state').hidden,false);
    x.click('device-refresh');await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
    x.click('device-unlock');await until(()=>x.notesReads>=3);await tick();
    assert.equal(x.nodes.get('save-uncertainty-state').hidden,false);
  } finally {for(const write of x.queuedWrites)write.resolve(reply({error:'SYNTHETIC_REJECTION'},400));await tick();await tick();}
});

test('an uncertain save remains warned after explicit discard and is scoped to its owner',async t=>{
  const x=await setup(t,{initialId:ownerA,loginId:ownerB});x.queueWrites=true;
  try {
    editExisting(x,'fixture local edit','fixture local body');
    descendants(x.nodes.get('notes'),'button').find(b=>b.textContent==='수정 저장').dispatchEvent(new Event('click'));
    await until(()=>x.queuedWrites.length===1);
    x.queuedWrites[0].resolve(reply({error:'SYNTHETIC_TIMEOUT'},408));
    await until(()=>x.notesReads>=2);await tick();
    assert.equal(x.nodes.get('save-uncertainty-state').hidden,false,'HTTP timeout must remain uncertain');
    const discard=descendants(x.nodes.get('notes'),'button').find(b=>/서버.*유지.*수정.*버리/u.test(b.textContent));
    assert.ok(discard);discard.dispatchEvent(new Event('click'));await tick();
    assert.equal(x.nodes.get('save-uncertainty-state').hidden,false,'discard cannot cancel an earlier request');
    x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);
    await loginAndVerify(x);await until(()=>x.notesReads>=3);await tick();
    assert.equal(x.nodes.get('save-uncertainty-state').hidden,true,'another owner must not see this account notice');
    x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);
    x.loginId=ownerA;await loginAndVerify(x);await until(()=>x.notesReads>=4);await tick();
    assert.equal(x.nodes.get('save-uncertainty-state').hidden,false,'same-owner reauthentication must restore the warning');
  } finally {for(const write of x.queuedWrites)write.resolve(reply({error:'SYNTHETIC_REJECTION'},400));await tick();await tick();}
});

for(const next of ['save','delete']) for(const outcome of ['success','rejection','server','network']) test(`an older ${outcome} save does not overwrite a newer ${next}`,async t=>{
  const notes=[{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',title:'fixture a',body:'fixture a'},{id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',title:'fixture b',body:'fixture b'}];
  const x=await setup(t,{initialId:ownerA,initialNotes:notes});x.queueWrites=true;
  try {
    const [a,b]=x.nodes.get('notes').children;
    descendants(a,'button').find(item=>item.textContent==='수정 저장').dispatchEvent(new Event('click'));
    await until(()=>x.queuedWrites.length===1);
    descendants(b,'button').find(item=>item.textContent===(next==='save'?'수정 저장':'삭제')).dispatchEvent(new Event('click'));
    await until(()=>x.queuedWrites.length===2);
    if(outcome==='network')x.queuedWrites[0].reject(Error('synthetic disconnected'));
    else x.queuedWrites[0].resolve(reply(outcome==='success'?{ok:true}:{error:'SYNTHETIC_FAILURE'},outcome==='success'?200:outcome==='server'?503:400));
    await until(()=>!x.nodes.get('save-operation-status').hidden);await tick();await tick();
    assert.equal(x.nodes.get('workspace-status').textContent,next==='save'?'수정 중…':'삭제 중…');
    assert.match(x.nodes.get('save-operation-status').textContent,/수정/);
  } finally {for(const write of x.queuedWrites)write.resolve(reply({error:'SYNTHETIC_REJECTION'},400));await tick();await tick();}
});

test('a late save response after switching owners warns only the original owner',async t=>{
  const x=await setup(t,{initialId:ownerA,loginId:ownerB});x.queueWrites=true;
  try {
    editExisting(x,'fixture local edit','fixture local body');
    descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='수정 저장').dispatchEvent(new Event('click'));
    await until(()=>x.queuedWrites.length===1);
    x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);
    await loginAndVerify(x);await until(()=>x.notesReads>=2);
    x.queuedWrites[0].resolve(reply({ok:true},200));await tick();await tick();
    assert.equal(x.nodes.get('save-uncertainty-state').hidden,true);
    assert.equal(x.nodes.get('save-operation-status').hidden,true);
    x.click('logout');await until(()=>!x.nodes.get('signed-out').hidden);
    x.loginId=ownerA;await loginAndVerify(x);await until(()=>x.notesReads>=3);await tick();
    assert.equal(x.nodes.get('save-uncertainty-state').hidden,false);
  } finally {for(const write of x.queuedWrites)write.resolve(reply({error:'SYNTHETIC_REJECTION'},400));await tick();await tick();}
});

for (const [initialId,refreshId] of [[undefined,undefined],[ownerA,ownerB],[ownerA,undefined],[undefined,ownerB]]) {
  for (const action of ['save','delete']) test(`operation result does not cross an unverified or different owner: ${String(initialId)} to ${String(refreshId)} ${action}`,async t=>{
    const x=await setup(t,{initialId,refreshId,refreshFailure:'valid'});x.queueWrites=true;
    try {
      if(action==='save')editExisting(x,'fixture local edit','fixture local body');
      descendants(x.nodes.get('notes'),'button').find(item=>item.textContent===(action==='save'?'수정 저장':'삭제')).dispatchEvent(new Event('click'));
      await until(()=>x.queuedWrites.length===1);
      x.deferPost=true;x.nodes.get('new-title').value='fixture new';x.nodes.get('new-body').value='fixture body';
      x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));await until(()=>x.postCalls===2);
      const result=x.nodes.get(action==='save'?'save-operation-status':'delete-operation-status');
      x.queuedWrites[0].resolve(reply({error:'SYNTHETIC_OWNER_A'},400));await until(()=>!result.hidden);
      x.post.resolve(reply({error:'UNAUTHORIZED'},401));await until(()=>x.sessionCalls>=2&&x.nodes.get('workspace').hidden);
      x.click('device-unlock');await until(()=>!x.nodes.get('workspace').hidden);await tick();
      assert.equal(result.hidden,true,'an unverified or different owner must not inherit a prior operation result');
      assert.doesNotMatch(result.textContent,/SYNTHETIC_OWNER_A/);
    } finally {x.post.resolve(reply({error:'FIXTURE'},400));for(const w of x.queuedWrites)w.resolve(reply({error:'FIXTURE'},400));await tick();await tick();}
  });
}

test('the shared workspace error does not cross a different owner after session refresh',async t=>{
  const x=await setup(t,{initialId:ownerA,refreshId:ownerB,refreshFailure:'valid',delayNotesRead:2});x.queueWrites=true;
  try {
    editExisting(x,'fixture local edit','fixture local body');
    descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='수정 저장').dispatchEvent(new Event('click'));
    await until(()=>x.queuedWrites.length===1);x.queuedWrites[0].resolve(reply({error:'SYNTHETIC_OWNER_A'},400));
    await until(()=>x.nodes.get('workspace-status').textContent.includes('SYNTHETIC_OWNER_A'));
    x.click('device-refresh');await until(()=>x.nodes.get('workspace').hidden);x.click('device-unlock');
    await until(()=>x.notesReads===2);x.notesRead.resolve(reply({error:'UNAUTHORIZED'},401));
    await until(()=>x.sessionCalls>=2&&x.nodes.get('workspace').hidden);
    x.click('device-unlock');await until(()=>!x.nodes.get('workspace').hidden);await tick();
    assert.doesNotMatch(x.nodes.get('workspace-status').textContent,/SYNTHETIC_OWNER_A/);
  } finally {x.notesRead.resolve(reply([]));for(const w of x.queuedWrites)w.resolve(reply({error:'FIXTURE'},400));await tick();await tick();}
});

for(const action of ['save','delete']) test(`a ${action} result remains available after same-owner session refresh`,async t=>{
  const x=await setup(t,{initialId:ownerA,refreshId:ownerA,refreshFailure:'valid'});x.queueWrites=true;
  try {
    if(action==='save')editExisting(x,'fixture local edit','fixture local body');
    descendants(x.nodes.get('notes'),'button').find(item=>item.textContent===(action==='save'?'수정 저장':'삭제')).dispatchEvent(new Event('click'));
    await until(()=>x.queuedWrites.length===1);
    x.deferPost=true;x.nodes.get('new-title').value='fixture new';x.nodes.get('new-body').value='fixture body';
    x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));await until(()=>x.postCalls===2);
    const result=x.nodes.get(action==='save'?'save-operation-status':'delete-operation-status');
    x.queuedWrites[0].resolve(reply({error:'SYNTHETIC_SAME_OWNER'},400));await until(()=>!result.hidden);
    x.post.resolve(reply({error:'UNAUTHORIZED'},401));await until(()=>x.sessionCalls>=2&&x.nodes.get('workspace').hidden);
    x.click('device-unlock');await until(()=>!x.nodes.get('workspace').hidden);await tick();
    assert.equal(result.hidden,false);
    assert.match(result.textContent,/SYNTHETIC_SAME_OWNER/);
  } finally {x.post.resolve(reply({error:'FIXTURE'},400));for(const w of x.queuedWrites)w.resolve(reply({error:'FIXTURE'},400));await tick();await tick();}
});

test('an unidentified session keeps its save result across a device-only reauthentication',async t=>{
  const x=await setup(t);x.queueWrites=true;
  try {
    editExisting(x,'fixture local edit','fixture local body');
    descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='수정 저장').dispatchEvent(new Event('click'));
    await until(()=>x.queuedWrites.length===1);
    x.deferPost=true;x.nodes.get('new-title').value='fixture new';x.nodes.get('new-body').value='fixture body';
    x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));await until(()=>x.postCalls===2);
    const result=x.nodes.get('save-operation-status');
    x.queuedWrites[0].resolve(reply({error:'SYNTHETIC_SAME_SESSION'},400));await until(()=>!result.hidden);
    x.click('device-refresh');await until(()=>x.nodes.get('workspace').hidden);
    x.click('device-unlock');await until(()=>!x.nodes.get('workspace').hidden);await tick();
    assert.match(result.textContent,/SYNTHETIC_SAME_SESSION/);
  } finally {x.post.resolve(reply({error:'FIXTURE'},400));for(const w of x.queuedWrites)w.resolve(reply({error:'FIXTURE'},400));await tick();await tick();}
});

for(const outcome of ['rejection','server']) test(`a delayed ${outcome} save response cannot reveal its result to another owner`,async t=>{
  const x=await setup(t,{initialId:ownerA,refreshId:ownerB,refreshFailure:'valid',delayNotesRead:2});x.queueWrites=true;
  const body=deferred();let bodyRead=false;
  try {
    editExisting(x,'fixture local edit','fixture local body');
    descendants(x.nodes.get('notes'),'button').find(item=>item.textContent==='수정 저장').dispatchEvent(new Event('click'));
    await until(()=>x.queuedWrites.length===1);
    x.queuedWrites[0].resolve({ok:false,status:outcome==='server'?503:400,json(){bodyRead=true;return body.promise;}});
    await until(()=>bodyRead);
    x.click('device-refresh');await until(()=>x.nodes.get('workspace').hidden);x.click('device-unlock');
    await until(()=>x.notesReads===2);x.notesRead.resolve(reply({error:'UNAUTHORIZED'},401));
    await until(()=>x.sessionCalls>=2&&x.nodes.get('workspace').hidden);
    x.click('device-unlock');await until(()=>!x.nodes.get('workspace').hidden);await tick();
    body.resolve({error:'SYNTHETIC_OWNER_A_LATE'});await tick();await tick();
    assert.equal(x.nodes.get('save-operation-status').hidden,true);
    assert.doesNotMatch(x.nodes.get('workspace-status').textContent,/SYNTHETIC_OWNER_A_LATE/);
    assert.equal(x.nodes.get('save-uncertainty-state').hidden,true);
  } finally {body.resolve({error:'FIXTURE'});x.notesRead.resolve(reply([]));for(const w of x.queuedWrites)w.resolve(reply({error:'FIXTURE'},400));await tick();await tick();}
});
