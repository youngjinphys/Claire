import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const until=async fn=>{for(let i=0;i<100;i++){if(fn())return;await tick();}throw Error('fixture timed out');};
const deferred=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};};
const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
class Element extends EventTarget{
  constructor(){super();this.hidden=false;this.disabled=false;this.textContent='';this.value='';this.children=[];this.classList={toggle(){},add(){},remove(){}};}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this.children=[...children];}
}
const ids=['signed-out','signed-in','workspace','login-form','logout','login-status','workspace-status','draft-warning','session-label','notes','create-form','email','password','new-title','new-body','device-state','device-detail','device-enroll','device-unlock','device-refresh','device-panel','pwa-state','pwa-install','ops-state','auth-coordination-state'];
const html=await readFile(process.env.CLAIRE_COOKIE_TEST_INDEX || new URL('../public/index.html',import.meta.url),'utf8');
const inline=html.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
assert.ok(inline);
const script=inline.replace("import('/device.mjs')","Promise.resolve({initDeviceAccess:({onAuthorized})=>{window.__authorize=()=>onAuthorized('fixture-proof',120);return {status(){},lock(){}}}})")
  .replace("import('/operations.mjs')","Promise.resolve({initOperations(){}})");
function sharedContext({locks=true,storageAvailable=locks,deliverStorageEvents=true,manualTimers=false,seedPointer=true}={}){
  let tail=Promise.resolve(),version=0,stableWriteHook=null,lockFailure=null,syncObservationFailure=false,observationGate=null,observationStarted=false;
  const stored=new Map(),cookies=new Map(),windows=[],writes=[],cookieWrites=[];
  // Tests that start with a session represent an existing bound browser.
  // The value is a synthetic coordination marker, not a credential.
  if(seedPointer)cookies.set('__Host-claire_gen','0'.repeat(32));
  const lockManager=locks?{request(_name,options,callback){
    if(!options.signal&&syncObservationFailure&&lockFailure)throw new DOMException('synthetic lock failure',lockFailure);
    if(!options.signal&&observationGate){const gate=observationGate;observationGate=null;observationStarted=true;return gate.promise;}
    const run=tail.then(()=>{if(options.signal?.aborted)throw new DOMException('aborted','AbortError');if(lockFailure)throw new DOMException('synthetic lock failure',lockFailure);return callback({});});
    tail=run.catch(()=>{});return run;
  }}:undefined;
  function page(fetch,{pageLocks=locks,storageWritesBlocked=false}={}){
    const nodes=new Map(ids.map(id=>[id,new Element()]));let failStorageWrites=storageWritesBlocked,failStorageReads=false;const timers=[];
    for(const id of ['signed-in','workspace','device-panel','draft-warning'])nodes.get(id).hidden=true;
    const win=new EventTarget();windows.push(win);win.matchMedia=()=>({matches:false});win.confirm=()=>true;
    const storage={getItem(key){if(failStorageReads)throw Error('fixture storage denied');return stored.get(key)??null;},setItem(key,value){if(failStorageWrites)throw Error('fixture storage denied');if(stableWriteHook&&key==='aleph.auth.version.v1'&&!String(value).startsWith('pending:')){const hook=stableWriteHook;stableWriteHook=null;hook();}writes.push([key,String(value)]);stored.set(key,String(value));if(!deliverStorageEvents)return;for(const other of windows){if(other===win)continue;const e=new Event('storage');Object.assign(e,{key,newValue:String(value),storageArea:other.localStorage});other.dispatchEvent(e);}},removeItem(key){if(failStorageWrites)throw Error('fixture storage denied');stored.delete(key);}};
    if(storageAvailable)win.localStorage=storage;
    const doc={querySelector:s=>nodes.get(s.slice(1)),getElementById:id=>nodes.get(id),createElement:()=>new Element()};
    Object.defineProperty(doc,'cookie',{
      get(){return [...cookies].map(([key,value])=>`${key}=${value}`).join('; ');},
      set(value){
        cookieWrites.push(String(value));
        const [pair,...attributes]=String(value).split(';');
        const separator=pair.indexOf('=');
        if(separator<1)return;
        const key=pair.slice(0,separator).trim(),cookieValue=pair.slice(separator+1);
        if(attributes.some(attribute=>/^\s*Max-Age\s*=\s*0\s*$/iu.test(attribute)))cookies.delete(key);
        else cookies.set(key,cookieValue);
      },
    });
    const nav=pageLocks&&lockManager?{locks:lockManager}:{};
    const crypto={randomUUID:()=>`fixture-version-${++version}`,getRandomValues:a=>{a.fill(++version);return a;}};
    const schedule=manualTimers?fn=>{const timer={fn,active:true};timers.push(timer);return timer;}:setTimeout;
    const cancel=manualTimers?timer=>{if(timer)timer.active=false;}:clearTimeout;
    const location={protocol:'https:',hostname:'fixture.invalid',port:''};
    const context={window:win,document:doc,location,navigator:nav,crypto,fetch,Response,Headers,Event,EventTarget,AbortController,DOMException,setTimeout:schedule,clearTimeout:cancel,console};
    runInNewContext(script,context);
    return {nodes,win,setFailStorageWrites(value){failStorageWrites=value;},setFailStorageReads(value){failStorageReads=value;},fireTimers(){for(const timer of timers)if(timer.active){timer.active=false;timer.fn();}},click:id=>nodes.get(id).dispatchEvent(new Event('click')),
      login(){nodes.get('email').value='fixture@example.invalid';nodes.get('password').value='fixture-only';nodes.get('login-form').dispatchEvent(new Event('submit',{cancelable:true}));}};
  }
  return {page,writes,cookieWrites,setLockFailure(name,{syncObservation=false}={}){lockFailure=name;syncObservationFailure=syncObservation;},holdNextObservation(){observationGate=deferred();observationStarted=false;return observationGate;},get observationStarted(){return observationStarted;},onNextStableWrite(fn){stableWriteHook=fn;}};
}

test('a fresh browser without a coordination cookie permits an explicit login',async()=>{
  let logins=0;
  const page=sharedContext({seedPointer:false}).page(async path=>{
    if(path==='/api/auth/session')return reply({error:'NO_SESSION'},401);
    if(path==='/api/auth/login'){
      logins++;
      return reply({accessToken:'fixture-new',user:{email:'fixture@example.invalid'}});
    }
    throw Error('unexpected fixture request');
  });
  await tick();await tick();
  page.login();
  await until(()=>logins===1&&!page.nodes.get('signed-in').hidden);
});

for(const failure of ['SecurityError','NotSupportedError','TypeError']) test(`a runtime ${failure} lock rejection is explained on a later login`,async()=>{
  const shared=sharedContext();let sessions=0,logins=0,logouts=0;
  const page=shared.page(async path=>{
    if(path==='/api/auth/session'){sessions++;return reply({accessToken:'fixture-session',user:{id:'11111111-1111-4111-8111-111111111111',email:'fixture@example.invalid'}});}
    if(path==='/api/auth/login'){logins++;return reply({error:'LOGIN_FAILED'},401);}
    if(path==='/api/auth/logout'){logouts++;return reply({ok:true});}
    throw Error('unexpected fixture request');
  });
  await until(()=>sessions===1&&!page.nodes.get('signed-in').hidden);
  page.nodes.get('new-title').value='fixture held draft';
  shared.setLockFailure(failure);page.click('logout');
  await until(()=>page.nodes.get('login-status').textContent.includes('확인하지 못'));
  assert.equal(page.nodes.get('auth-coordination-state').hidden,false);
  assert.match(page.nodes.get('auth-coordination-state').textContent,/잠금.*요청.*(보낼 수 없|보내지 않)/);
  page.login();
  await until(()=>!/로그인 중/.test(page.nodes.get('login-status').textContent));
  assert.match(page.nodes.get('login-status').textContent,/잠금.*요청.*보내지 않/);
  assert.match(page.nodes.get('login-status').textContent,/작성 내용.*보관/);
  assert.equal(logins,0);assert.equal(logouts,0);
});

test('a lock rejection during initial restoration remains visible when login is requested',async()=>{
  const shared=sharedContext();shared.setLockFailure('SecurityError');let requests=0;
  const page=shared.page(async()=>{requests++;return reply({error:'NO_SESSION'},401);});
  await until(()=>!page.nodes.get('auth-coordination-state').hidden);
  assert.match(page.nodes.get('auth-coordination-state').textContent,/잠금.*요청.*(보낼 수 없|보내지 않)/);
  page.login();await until(()=>!/로그인 중/.test(page.nodes.get('login-status').textContent));
  assert.match(page.nodes.get('login-status').textContent,/잠금.*요청.*보내지 않/);
  assert.equal(requests,0);
});

test('an older lock rejection cannot leave a newer login showing progress',async()=>{
  const shared=sharedContext();shared.setLockFailure('SecurityError');let requests=0;
  const page=shared.page(async()=>{requests++;return reply({error:'NO_SESSION'},401);});
  await until(()=>!page.nodes.get('auth-coordination-state').hidden);
  page.login();page.login();
  await until(()=>!/로그인 중/.test(page.nodes.get('login-status').textContent));
  assert.match(page.nodes.get('login-status').textContent,/잠금.*요청.*보내지 않/);
  assert.equal(requests,0);
});

for(const [failure,synchronous] of [['SecurityError',false],['SecurityError',true],['AbortError',false]])
test(`a ${synchronous?'synchronous ':''}${failure} while observing another tab does not leave a pending old vault open`,async()=>{
  const shared=sharedContext();let sessions=0;
  const fetch=async path=>{
    if(path==='/api/auth/session'){sessions++;return reply({accessToken:'fixture-session',user:{id:'11111111-1111-4111-8111-111111111111',email:'fixture@example.invalid'}});}
    throw Error('unexpected fixture request');
  };
  const a=shared.page(fetch),b=shared.page(fetch);
  await until(()=>sessions===2&&!a.nodes.get('signed-in').hidden&&!b.nodes.get('signed-in').hidden);
  b.nodes.get('new-title').value='fixture held draft';
  shared.setLockFailure(failure,{syncObservation:synchronous});
  a.win.localStorage.setItem('aleph.auth.version.v1','pending:'+('a'.repeat(32)));
  await until(()=>b.nodes.get('signed-in').hidden);
  assert.equal(b.nodes.get('workspace').hidden,true);
  assert.match(b.nodes.get('login-status').textContent,/작성 내용.*보관/);
  assert.equal(b.nodes.get('auth-coordination-state').hidden,failure==='AbortError');
  if(failure!=='AbortError')assert.match(b.nodes.get('auth-coordination-state').textContent,/잠금.*요청.*보내지/);
});

test('a delayed observation lock rejection cannot invalidate a newer authenticated session',async()=>{
  const shared=sharedContext();let sessions=0,logins=0;
  const fetch=async path=>{
    if(path==='/api/auth/session'){sessions++;return reply({accessToken:'fixture-a',user:{id:'11111111-1111-4111-8111-111111111111',email:'a@example.invalid'}});}
    if(path==='/api/auth/login'){logins++;return reply({accessToken:'fixture-b',user:{id:'22222222-2222-4222-8222-222222222222',email:'b@example.invalid'}});}
    throw Error('unexpected fixture request');
  };
  const a=shared.page(fetch),b=shared.page(fetch);
  await until(()=>sessions===2&&!a.nodes.get('signed-in').hidden&&!b.nodes.get('signed-in').hidden);
  const gate=shared.holdNextObservation();
  try {
    a.win.localStorage.setItem('aleph.auth.version.v1','pending:'+('a'.repeat(32)));
    await until(()=>shared.observationStarted);
    a.win.localStorage.setItem('aleph.auth.version.v1','b'.repeat(32));
    await until(()=>b.nodes.get('signed-in').hidden);
    b.login();await until(()=>logins===1&&!b.nodes.get('signed-in').hidden);
    gate.reject(new DOMException('synthetic lock failure','SecurityError'));await tick();await tick();
    assert.equal(b.nodes.get('signed-in').hidden,false);
    assert.match(b.nodes.get('session-label').textContent,/b@example\.invalid/);
    assert.equal(b.nodes.get('auth-coordination-state').hidden,false);
  } finally {gate.resolve();await tick();await tick();}
});

test('an abandoned authentication marker refuses a new cookie mutation until its outcome is verified',async()=>{
  let sessions=0,logins=0;
  const shared=sharedContext();
  const fetch=async path=>{
    if(path==='/api/auth/session'){sessions++;return reply({error:'NO_SESSION'},401);}
    if(path==='/api/auth/login'){logins++;return reply({accessToken:'fixture-new-session',user:{email:'fixture@example.invalid'}});}
    throw Error('unexpected fixture request');
  };
  const first=shared.page(fetch);
  await tick();await tick();
  first.win.localStorage.setItem('aleph.auth.version.v1','pending:'+('a'.repeat(32)));
  const next=shared.page(fetch);
  await tick();await tick();
  next.login();
  for(let i=0;i<20;i++)await tick();
  // The pending value may still represent an in-flight Set-Cookie. The page
  // cannot prove it is abandoned; explicit login must not bypass that boundary.
  assert.equal(logins,0,'unresolved pending state cannot safely send credentials');
  assert.equal(next.nodes.get('signed-in').hidden,true);
  assert.match(next.nodes.get('login-status').textContent,/완료 상태|잠금|인증/);
});

test('pagehide cancels an active logout and leaves subsequent restoration fail closed',async()=>{
  const logout=deferred();
  let sessions=0,logins=0,logoutSignal;
  const shared=sharedContext();
  const fetch=async(path,init)=>{
    if(path==='/api/auth/session'){
      sessions++;
      return reply({error:'NO_SESSION'},401);
    }
    if(path==='/api/auth/logout'){logoutSignal=init.signal;return logout.promise;}
    if(path==='/api/auth/login'){logins++;return reply({accessToken:'fixture-new',user:{email:'fixture@example.invalid'}});}
    throw Error('unexpected fixture request');
  };
  const first=shared.page(fetch);
  try {
    await tick();await tick();
    first.login();
    await until(()=>logins===1&&!first.nodes.get('signed-in').hidden);
    first.click('logout');
    await until(()=>logoutSignal);
    first.win.dispatchEvent(new Event('pagehide'));
    assert.equal(logoutSignal.aborted,true,'pagehide cancels the request to release the browser auth lock');
    const next=shared.page(fetch);
    for(let i=0;i<20;i++)await tick();
    assert.equal(next.nodes.get('signed-in').hidden,true,
      'an unconfirmed logout must not silently restore an older cookie');
    assert.equal(logins,1,'a cancelled logout is not permission to start another auth automatically');
  } finally {logout.resolve(reply({ok:true}));}
});

test('a queued logout without storage still prevents silent restoration after pagehide',async()=>{
  const refresh=deferred();let sessions=0,logins=0,logouts=0;
  const shared=sharedContext({locks:false});
  const fetch=async(path,init={})=>{
    if(path==='/api/auth/session'){
      sessions++;
      if(sessions===1)return refresh.promise;
      return reply({accessToken:'fixture',user:{id:'11111111-1111-4111-8111-111111111111',email:'fixture@example.invalid'}});
    }
    if(path==='/api/auth/login'){logins++;return reply({accessToken:'fixture',user:{id:'11111111-1111-4111-8111-111111111111'}});}
    if(path==='/api/auth/logout'){logouts++;return reply({ok:true});}
    if(path==='/api/notes'&&init.method==='POST')return reply({error:'UNAUTHORIZED'},401);
    if(path==='/api/notes')return reply([]);
    throw Error('unexpected fixture request');
  };
  const first=shared.page(fetch);
  try {
    await until(()=>typeof first.win.__authorize==='function');first.login();
    await until(()=>logins===1&&!first.nodes.get('signed-in').hidden);
    first.win.__authorize();
    first.nodes.get('new-title').value='synthetic draft';
    first.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
    await until(()=>sessions===1);
    first.click('logout');
    first.win.dispatchEvent(new Event('pagehide'));
    refresh.resolve(reply({accessToken:'fixture',user:{id:'11111111-1111-4111-8111-111111111111',email:'fixture@example.invalid'}}));
    for(let i=0;i<20;i++)await tick();
    const next=shared.page(fetch);
    for(let i=0;i<30;i++)await tick();
    assert.equal(logouts,0,'the fixture keeps the logout queued before pagehide');
    assert.equal(next.nodes.get('signed-in').hidden,true,'the requested logout must not be silently undone');
  } finally {refresh.resolve(reply({error:'NO_SESSION'},401));}
});

test('pagehide releases logout after response headers when the body is stalled',async()=>{
  const body=deferred();let logins=0,logouts=0,readStarted=false,logoutSignal;
  const shared=sharedContext();
  const fetch=async (path,init={})=>{
    if(path==='/api/auth/session')return reply({error:'NO_SESSION'},401);
    if(path==='/api/auth/login'){logins++;return reply({accessToken:'fixture-new',user:{email:'fixture@example.invalid'}});}
    if(path==='/api/auth/logout'){
      logouts++;logoutSignal=init.signal;
      return {ok:true,status:200,json:()=>{
        readStarted=true;
        // A real Fetch response body rejects when its request is aborted.
        return new Promise((resolve,reject)=>{
          const abort=()=>reject(new DOMException('aborted','AbortError'));
          if(logoutSignal.aborted) abort();
          else {logoutSignal.addEventListener('abort',abort,{once:true});body.promise.then(resolve,reject);}
        });
      }};
    }
    throw Error('unexpected fixture request');
  };
  const first=shared.page(fetch);
  try {
    await tick();await tick();first.login();
    await until(()=>logins===1&&!first.nodes.get('signed-in').hidden);
    first.click('logout');await until(()=>logouts===1&&readStarted);
    first.win.dispatchEvent(new Event('pagehide'));
    assert.equal(logoutSignal.aborted,true,'pagehide must abort the stalled response body');
    const next=shared.page(fetch);for(let i=0;i<20;i++)await tick();next.login();
    for(let i=0;i<20;i++)await tick();
    assert.equal(logins,2,'the next login must not wait for a stalled logout response');
  } finally {body.resolve({ok:true});}
});

test('the auth request timeout remains active while the response body is pending',async()=>{
  let controllerSignal,sessionCalls=0;
  const page=sharedContext({manualTimers:true}).page(async(path,init)=>{
    if(path!=='/api/auth/session')throw Error('unexpected fixture request');
    sessionCalls++;controllerSignal=init.signal;
    return {status:200,ok:true,json:()=>new Promise((_,reject)=>controllerSignal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true}))};
  });
  await until(()=>sessionCalls===1);await tick();await tick();
  page.fireTimers();await tick();
  assert.equal(controllerSignal.aborted,true,'the timeout must cover the response body');
});

test('a delayed initial session finishes before the later login can set its cookie',async()=>{
  const first=deferred();let cookie='',logins=0,sessions=0;
  const x=sharedContext().page(async path=>{
    if(path==='/api/auth/session'){sessions++;await first.promise;cookie='old';return reply({accessToken:'old',user:{email:'old@example.invalid'}});}
    if(path==='/api/auth/login'){logins++;cookie='new';return reply({accessToken:'new',user:{email:'new@example.invalid'}});}
    throw Error('unexpected fixture request');
  });
  await until(()=>sessions===1);x.login();await tick();await tick();
  assert.equal(logins,0,'login must wait for the earlier cookie response');
  first.resolve();await until(()=>logins===1);await until(()=>x.nodes.get('signed-in').hidden===false);
  assert.equal(cookie,'new');
});

test('a delayed logout cannot clear the cookie from a later login',async()=>{
  const logout=deferred();let cookie='old',logins=0,logouts=0;
  const x=sharedContext().page(async path=>{
    if(path==='/api/auth/session')return reply({accessToken:'old',user:{email:'old@example.invalid'}});
    if(path==='/api/auth/logout'){logouts++;await logout.promise;cookie='';return reply({ok:true});}
    if(path==='/api/auth/login'){logins++;cookie='new';return reply({accessToken:'new',user:{email:'new@example.invalid'}});}
    throw Error('unexpected fixture request');
  });
  await until(()=>x.nodes.get('signed-in').hidden===false);x.click('logout');await until(()=>logouts===1);
  x.login();await tick();await tick();assert.equal(logins,0,'login must wait for logout response');
  logout.resolve();await until(()=>logins===1);await until(()=>x.nodes.get('signed-in').hidden===false);
  assert.equal(cookie,'new');
});

test('without cross-tab coordination the same tab still serializes authentication',async()=>{
  const first=deferred();let cookie='',logins=0,sessions=0;
  const x=sharedContext({locks:false,storageAvailable:true}).page(async path=>{
    if(path==='/api/auth/session'){sessions++;await first.promise;cookie='old';return reply({accessToken:'old',user:{email:'old@example.invalid'}});}
    if(path==='/api/auth/login'){logins++;cookie='new';return reply({accessToken:'new',user:{email:'new@example.invalid'}});}
    throw Error('unexpected fixture request');
  });
  await until(()=>sessions===1);x.login();await tick();await tick();assert.equal(logins,0);
  first.resolve();await until(()=>logins===1);assert.equal(cookie,'new');
  assert.equal(x.nodes.get('auth-coordination-state').hidden,false);
  assert.match(x.nodes.get('auth-coordination-state').textContent,/한 탭/);
});

test('logout failure leaves the local vault locked and explains remote uncertainty',async()=>{
  const x=sharedContext().page(async path=>{
    if(path==='/api/auth/session')return reply({accessToken:'old',user:{email:'old@example.invalid'}});
    if(path==='/api/auth/logout')throw Error('fixture network failure');
    throw Error('unexpected fixture request');
  });
  await until(()=>x.nodes.get('signed-in').hidden===false);x.click('logout');
  await until(()=>x.nodes.get('login-status').textContent.includes('서버'));
  assert.equal(x.nodes.get('workspace').hidden,true);
  assert.equal(x.nodes.get('signed-out').hidden,false);
});

test('logout result keeps the existing notice that an unsaved draft is held',async()=>{
  const x=sharedContext().page(async path=>{
    if(path==='/api/auth/session')return reply({accessToken:'old',user:{email:'old@example.invalid',id:'11111111-1111-4111-8111-111111111111'}});
    if(path==='/api/auth/logout')return reply({ok:true});
    throw Error('unexpected fixture request');
  });
  await until(()=>x.nodes.get('signed-in').hidden===false);
  x.nodes.get('new-title').value='fixture draft';x.click('logout');
  await until(()=>x.nodes.get('login-status').textContent.includes('서버 응답'));
  assert.match(x.nodes.get('login-status').textContent,/작성 내용.*보관/);
});

for(const outcome of ['success','failure']){
  test(`logout ${outcome} shows pending state without discarding its draft notice`,async()=>{
    const gate=deferred();let logouts=0;
    const x=sharedContext().page(async path=>{
      if(path==='/api/auth/session')return reply({accessToken:'old',user:{email:'old@example.invalid',id:'11111111-1111-4111-8111-111111111111'}});
      if(path==='/api/auth/logout'){logouts++;return gate.promise;}
      throw Error('unexpected fixture request');
    });
    await until(()=>x.nodes.get('signed-in').hidden===false);
    x.nodes.get('new-title').value='fixture draft';x.click('logout');
    try {
      assert.equal(x.nodes.get('workspace').hidden,true);
      assert.match(x.nodes.get('login-status').textContent,/작성 내용.*보관/);
      assert.match(x.nodes.get('login-status').textContent,/잠겼.*서버.*확인 중/);
    } finally {gate.resolve(outcome==='success'?reply({ok:true}):reply({error:'FIXTURE'},503));}
    await until(()=>logouts===1);
    await until(()=>x.nodes.get('login-status').textContent.includes(outcome==='success'?'서버 응답':'확인하지 못했습니다'));
    assert.match(x.nodes.get('login-status').textContent,/작성 내용.*보관/);
    assert.doesNotMatch(x.nodes.get('login-status').textContent,/확인 중/);
  });
}

test('an earlier logout result cannot overwrite a newer login pending status',async()=>{
  const logout=deferred(),login=deferred();let logouts=0,logins=0;
  const x=sharedContext().page(async path=>{
    if(path==='/api/auth/session')return reply({accessToken:'old',user:{email:'old@example.invalid'}});
    if(path==='/api/auth/logout'){logouts++;return logout.promise;}
    if(path==='/api/auth/login'){logins++;return login.promise;}
    throw Error('unexpected fixture request');
  });
  await until(()=>x.nodes.get('signed-in').hidden===false);x.click('logout');await until(()=>logouts===1);
  x.login();assert.match(x.nodes.get('login-status').textContent,/로그인 중/);
  try {
    logout.resolve(reply({ok:true}));await until(()=>logins===1);
    assert.match(x.nodes.get('login-status').textContent,/로그인 중/);
  } finally {login.resolve(reply({accessToken:'new',user:{email:'new@example.invalid'}}));}
  await until(()=>x.nodes.get('session-label').textContent.includes('new@example.invalid'));
});

test('a failed logout is not silently undone by automatic session restoration on reload',async()=>{
  let sessions=0;
  const shared=sharedContext();
  const fetch=async path=>{
    if(path==='/api/auth/session'){sessions++;return reply({accessToken:'old',user:{email:'old@example.invalid'}});}
    if(path==='/api/auth/logout')throw Error('fixture network failure');
    throw Error('unexpected fixture request');
  };
  const a=shared.page(fetch);await until(()=>sessions===1&&!a.nodes.get('signed-in').hidden);
  a.click('logout');await until(()=>a.nodes.get('login-status').textContent.includes('서버'));
  const reload=shared.page(fetch);await tick();await tick();
  assert.equal(sessions,1,'an unconfirmed logout must not silently restore the old cookie');
  assert.equal(reload.nodes.get('signed-out').hidden,false);
});

test('a logout that times out waiting for another auth request blocks silent restoration',async()=>{
  const gate=deferred();let sessions=0,logouts=0;
  const shared=sharedContext({manualTimers:true});
  const fetch=async path=>{
    if(path==='/api/auth/session'){sessions++;if(sessions===2)await gate.promise;return reply({accessToken:'old',user:{email:'old@example.invalid'}});}
    if(path==='/api/auth/logout'){logouts++;return reply({ok:true});}
    throw Error('unexpected fixture request');
  };
  const a=shared.page(fetch);await until(()=>sessions===1&&!a.nodes.get('signed-in').hidden);
  shared.page(fetch);await until(()=>sessions===2);
  a.click('logout');a.fireTimers();await until(()=>a.nodes.get('login-status').textContent.includes('서버'));
  gate.resolve();await tick();await tick();
  shared.page(fetch);await tick();await tick();
  assert.equal(logouts,0,'a timed-out queued logout must not later be sent');
  assert.equal(sessions,2,'the unconfirmed logout must block automatic restoration');
});

test('a logout intent immediately locks the other participating tab',async()=>{
  const gate=deferred();let sessions=0,logouts=0;
  const shared=sharedContext();
  const fetch=async path=>{
    if(path==='/api/auth/session'){sessions++;return reply({accessToken:'old',user:{email:'old@example.invalid'}});}
    if(path==='/api/auth/logout'){logouts++;await gate.promise;return reply({ok:true});}
    throw Error('unexpected fixture request');
  };
  const a=shared.page(fetch),b=shared.page(fetch);
  await until(()=>sessions===2&&!a.nodes.get('signed-in').hidden&&!b.nodes.get('signed-in').hidden);
  a.click('logout');await until(()=>logouts===1);
  try {
    assert.equal(b.nodes.get('workspace').hidden,true);
    assert.equal(b.nodes.get('signed-in').hidden,true);
  } finally { gate.resolve(); }
  await tick();
});

test('an unreadable successful login cannot silently restore its cookie on reload',async()=>{
  let sessions=0,logins=0;
  const shared=sharedContext();
  const fetch=async path=>{
    if(path==='/api/auth/session'){sessions++;return reply({error:'NO_SESSION'},401);}
    if(path==='/api/auth/login'){logins++;return new Response('{bad',{status:200,headers:{'Content-Type':'application/json'}});}
    throw Error('unexpected fixture request');
  };
  const a=shared.page(fetch);await until(()=>sessions===1);a.login();
  await until(()=>logins===1&&a.nodes.get('login-status').textContent.includes('로그인'));
  await tick();await tick();const b=shared.page(fetch);await tick();await tick();
  assert.equal(sessions,1,'an unconfirmed login must not silently restore the cookie');
  assert.equal(b.nodes.get('signed-out').hidden,false);
});

test('coordination storage contains only nonsecret random state',async()=>{
  let sessions=0,logins=0,logouts=0;
  const shared=sharedContext({manualTimers:true});
  const x=shared.page(async path=>{
    if(path==='/api/auth/session'){sessions++;return reply({accessToken:'fixture-access',user:{email:'fixture@example.invalid'}});}
    if(path==='/api/auth/login'){logins++;return reply({accessToken:'fixture-login',user:{email:'fixture@example.invalid'}});}
    if(path==='/api/auth/logout'){logouts++;return reply({ok:true});}
    if(path==='/api/notes')return reply([]);
    throw Error('unexpected fixture request');
  });
  await until(()=>sessions===1&&!x.nodes.get('signed-in').hidden);
  await until(()=>typeof x.win.__authorize==='function');x.win.__authorize();
  x.nodes.get('new-title').value='fixture draft';x.nodes.get('new-body').value='fixture body';
  x.login();await until(()=>logins===1);await tick();await tick();
  x.click('logout');await until(()=>logouts===1);await tick();
  assert.ok(shared.writes.length>0);
  for(const [key,value] of shared.writes){
    if(key==='aleph.auth.version.v1')
      assert.match(value,/^(?:|pending:[a-f0-9]{32}|(?:(?:logout|login)-unconfirmed:)?[a-f0-9]{32}~(?:[a-f0-9]{32}|initial))$/u);
    else {
      assert.match(key,/^aleph\.auth\.logout\.v1:(?:[a-f0-9]{32}|initial)$/u);
      assert.match(value,/^[a-f0-9]{32}$/u);
    }
  }
  assert.doesNotMatch(JSON.stringify(shared.writes),/fixture|@|proof|password|token/iu);
  for(const cookie of shared.cookieWrites){
    assert.match(cookie,/^__Host-claire_gen=(?:(?:logout:)?[a-f0-9]{32})?; Path=\/; SameSite=Strict; Max-Age=(?:604800|0); Secure$/u);
  }
  assert.doesNotMatch(JSON.stringify(shared.cookieWrites),/fixture|@|proof|password|token/iu);
});

test('an uncertain preceding refresh carries forward a timed-out logout intent',async()=>{
  const gate=deferred();let sessions=0,logouts=0;
  const shared=sharedContext({manualTimers:true});
  const fetch=async path=>{
    if(path==='/api/auth/session'){sessions++;if(sessions===2)await gate.promise;return reply({accessToken:'old',user:{email:'old@example.invalid'}});}
    if(path==='/api/auth/logout'){logouts++;return reply({ok:true});}
    throw Error('unexpected fixture request');
  };
  const a=shared.page(fetch);await until(()=>sessions===1&&!a.nodes.get('signed-in').hidden);
  const b=shared.page(fetch);await until(()=>sessions===2);
  a.click('logout');a.fireTimers();await until(()=>a.nodes.get('login-status').textContent.includes('서버'));
  b.fireTimers();gate.resolve();for(let i=0;i<30;i++)await tick();
  shared.page(fetch);for(let i=0;i<30;i++)await tick();
  assert.equal(logouts,0);
  assert.equal(sessions,2,'an uncertain previous refresh must not revive a deliberately logged-out cookie');
});

test('logout intent racing the stable write remains effective for an uncertain refresh',async()=>{
  const gate=deferred();let sessions=0,logouts=0;
  const shared=sharedContext({manualTimers:true});
  const fetch=async path=>{
    if(path==='/api/auth/session'){sessions++;if(sessions===2){await gate.promise;throw Error('fixture network failure');}return reply({accessToken:'old',user:{email:'old@example.invalid'}});}
    if(path==='/api/auth/logout'){logouts++;return reply({ok:true});}
    throw Error('unexpected fixture request');
  };
  const a=shared.page(fetch);await until(()=>sessions===1&&!a.nodes.get('signed-in').hidden);
  shared.page(fetch);await until(()=>sessions===2);
  shared.onNextStableWrite(()=>{a.click('logout');a.fireTimers();});gate.resolve();
  for(let i=0;i<30;i++)await tick();shared.page(fetch);for(let i=0;i<30;i++)await tick();
  assert.equal(logouts,0);
  assert.equal(sessions,2,'a late intent for the same lineage must prevent silent restoration');
});

test('a timed-out fetch retains the lock until the aborted operation actually settles',async()=>{
  const gate=deferred();let sessions=0,logins=0,firstSignal;
  const shared=sharedContext({manualTimers:true});
  const x=shared.page(async(path,init)=>{
    if(path==='/api/auth/session'){sessions++;return reply({accessToken:'old',user:{email:'old@example.invalid'}});}
    if(path==='/api/auth/login'){
      logins++;
      if(logins===1){firstSignal=init.signal;await gate.promise;}
      return reply({accessToken:'new',user:{email:'new@example.invalid'}});
    }
    throw Error('unexpected fixture request');
  });
  await until(()=>sessions===1&&!x.nodes.get('signed-in').hidden);
  x.login();await until(()=>logins===1);x.fireTimers();assert.equal(firstSignal.aborted,true);
  x.login();await tick();await tick();assert.equal(logins,1,'new auth must not begin while old fetch remains unsettled');
  gate.resolve();await until(()=>logins===2);
  await until(()=>x.nodes.get('session-label').textContent.includes('new@example.invalid'));
});

test('a queued older login is discarded before any request is sent',async()=>{
  const first=deferred();let logins=0,sessions=0;
  const x=sharedContext().page(async path=>{
    if(path==='/api/auth/session'){sessions++;await first.promise;return reply({error:'NO_SESSION'},401);}
    if(path==='/api/auth/login'){logins++;return reply({accessToken:'new',user:{email:'new@example.invalid'}});}
    throw Error('unexpected fixture request');
  });
  await until(()=>sessions===1);x.login();x.login();first.resolve();
  await until(()=>logins===1);await tick();await tick();assert.equal(logins,1);
});

test('a stale tab does not send logout with a newer tab login cookie',async()=>{
  const login=deferred();let loginCalls=0,logoutCalls=0,sessions=0;
  const shared=sharedContext();
  const fetch=async path=>{
    if(path==='/api/auth/session'){sessions++;return reply({accessToken:'old',user:{email:'old@example.invalid'}});}
    if(path==='/api/auth/login'){loginCalls++;await login.promise;return reply({accessToken:'new',user:{email:'new@example.invalid'}});}
    if(path==='/api/auth/logout'){logoutCalls++;return reply({ok:true});}
    throw Error('unexpected fixture request');
  };
  const a=shared.page(fetch),b=shared.page(fetch);
  await until(()=>sessions===2&&a.nodes.get('signed-in').hidden===false&&b.nodes.get('signed-in').hidden===false);
  b.login();await until(()=>loginCalls===1);a.click('logout');await tick();
  login.resolve();await until(()=>b.nodes.get('session-label').textContent.includes('new@example.invalid'));
  await tick();await tick();assert.equal(logoutCalls,0,'stale tab must not log out the newer account');
  assert.equal(a.nodes.get('workspace').hidden,true);
  assert.match(a.nodes.get('login-status').textContent,/서버|확인/);
});

test('a stale tab checks shared generation even if storage events are missed',async()=>{
  let sessions=0,logoutCalls=0;
  const shared=sharedContext({deliverStorageEvents:false});
  const fetch=async path=>{
    if(path==='/api/auth/session'){sessions++;return reply({accessToken:'old',user:{email:'old@example.invalid'}});}
    if(path==='/api/auth/login')return reply({accessToken:'new',user:{email:'new@example.invalid'}});
    if(path==='/api/auth/logout'){logoutCalls++;return reply({ok:true});}
    throw Error('unexpected fixture request');
  };
  const a=shared.page(fetch),b=shared.page(fetch);
  await until(()=>sessions===2&&a.nodes.get('signed-in').hidden===false&&b.nodes.get('signed-in').hidden===false);
  b.login();await until(()=>b.nodes.get('session-label').textContent.includes('new@example.invalid'));
  assert.equal(a.nodes.get('signed-in').hidden,false,'the fixture intentionally withheld the event');
  a.click('logout');await until(()=>a.nodes.get('login-status').textContent.includes('다른 탭'));
  assert.equal(logoutCalls,0);
  assert.equal(a.nodes.get('workspace').hidden,true);
});

test('a stale tab logout intent does not block the newer account on reload',async()=>{
  let sessions=0,logoutCalls=0,cookie='old';
  const shared=sharedContext({deliverStorageEvents:false});
  const fetch=async path=>{
    if(path==='/api/auth/session'){sessions++;return reply({accessToken:cookie,user:{email:cookie+'@example.invalid'}});}
    if(path==='/api/auth/login'){cookie='new';return reply({accessToken:'new',user:{email:'new@example.invalid'}});}
    if(path==='/api/auth/logout'){logoutCalls++;cookie='';return reply({ok:true});}
    throw Error('unexpected fixture request');
  };
  const a=shared.page(fetch),b=shared.page(fetch);
  await until(()=>sessions===2&&!a.nodes.get('signed-in').hidden&&!b.nodes.get('signed-in').hidden);
  b.login();await until(()=>b.nodes.get('session-label').textContent.includes('new@example.invalid'));
  a.click('logout');await until(()=>a.nodes.get('login-status').textContent.includes('다른 탭'));
  const reload=shared.page(fetch);await until(()=>sessions===3&&!reload.nodes.get('signed-in').hidden);
  assert.equal(logoutCalls,0);
  assert.match(reload.nodes.get('session-label').textContent,/new@example.invalid/);
});

test('pageshow locks stale UI after another tab changed authentication',async()=>{
  let sessions=0;
  const shared=sharedContext({deliverStorageEvents:false});
  const fetch=async path=>{
    if(path==='/api/auth/session'){sessions++;return reply({accessToken:'old',user:{email:'old@example.invalid'}});}
    if(path==='/api/auth/login')return reply({accessToken:'new',user:{email:'new@example.invalid'}});
    throw Error('unexpected fixture request');
  };
  const a=shared.page(fetch),b=shared.page(fetch);
  await until(()=>sessions===2&&a.nodes.get('signed-in').hidden===false&&b.nodes.get('signed-in').hidden===false);
  b.login();await until(()=>b.nodes.get('session-label').textContent.includes('new@example.invalid'));
  a.win.dispatchEvent(new Event('pageshow'));
  assert.equal(a.nodes.get('signed-out').hidden,false);
  assert.equal(a.nodes.get('workspace').hidden,true);
});

test('normal session refresh in another tab does not sign out the first tab',async()=>{
  let sessions=0;
  const shared=sharedContext();
  const fetch=async path=>{if(path==='/api/auth/session'){sessions++;return reply({accessToken:'old',user:{email:'old@example.invalid'}});}throw Error('unexpected');};
  const a=shared.page(fetch),b=shared.page(fetch);
  await until(()=>sessions===2&&!a.nodes.get('signed-in').hidden&&!b.nodes.get('signed-in').hidden);
  await tick();await tick();assert.equal(a.nodes.get('signed-in').hidden,false);
});

test('session rejection invalidates a previously authenticated tab',async()=>{
  let sessions=0;
  const shared=sharedContext();
  const fetch=async path=>{if(path==='/api/auth/session'){sessions++;return sessions===1?reply({accessToken:'old',user:{email:'old@example.invalid'}}):reply({error:'SESSION_EXPIRED'},401);}throw Error('unexpected');};
  const a=shared.page(fetch);await until(()=>sessions===1&&!a.nodes.get('signed-in').hidden);
  shared.page(fetch);await until(()=>sessions===2);await until(()=>a.nodes.get('signed-in').hidden);
  assert.equal(a.nodes.get('workspace').hidden,true);
});

test('a preflight storage write failure prevents a new cookie-mutating request',async()=>{
  let logins=0,sessions=0;
  const shared=sharedContext();
  const fetch=async path=>{if(path==='/api/auth/session'){sessions++;return reply({accessToken:'old',user:{email:'old@example.invalid'}});}if(path==='/api/auth/login'){logins++;return reply({accessToken:'new',user:{email:'new@example.invalid'}});}throw Error('unexpected');};
  const a=shared.page(fetch),b=shared.page(fetch);
  await until(()=>sessions===2&&!a.nodes.get('signed-in').hidden&&!b.nodes.get('signed-in').hidden);
  b.setFailStorageWrites(true);b.login();await tick();await tick();
  assert.equal(logins,0,'auth request must not proceed without publishing its pending state');
});

test('a failed final storage write leaves other tabs locked rather than trusting stale state',async()=>{
  const gate=deferred();let sessions=0,logins=0;
  const shared=sharedContext();
  const fetch=async path=>{if(path==='/api/auth/session'){sessions++;return reply({accessToken:'old',user:{email:'old@example.invalid'}});}if(path==='/api/auth/login'){logins++;await gate.promise;return reply({accessToken:'new',user:{email:'new@example.invalid'}});}throw Error('unexpected');};
  const a=shared.page(fetch),b=shared.page(fetch);
  await until(()=>sessions===2&&!a.nodes.get('signed-in').hidden&&!b.nodes.get('signed-in').hidden);
  b.login();await until(()=>logins===1);b.setFailStorageWrites(true);gate.resolve();
  await until(()=>a.nodes.get('signed-in').hidden);
  assert.equal(a.nodes.get('workspace').hidden,true);
});

test('a new tab adopts the stable generation after an existing session request finishes',async()=>{
  const gate=deferred();let sessions=0;
  const shared=sharedContext();
  const fetch=async path=>{
    if(path!=='/api/auth/session')throw Error('unexpected');
    sessions++;if(sessions===1)await gate.promise;
    return reply({accessToken:'fixture',user:{email:'fixture@example.invalid'}});
  };
  const a=shared.page(fetch);await until(()=>sessions===1);
  const b=shared.page(fetch);await tick();assert.equal(sessions,1);
  gate.resolve();await until(()=>sessions===2&&!a.nodes.get('signed-in').hidden&&!b.nodes.get('signed-in').hidden);
});

test('known temporary session backend failure does not sign out another tab',async()=>{
  let sessions=0;
  const shared=sharedContext();
  const fetch=async path=>{
    if(path!=='/api/auth/session')throw Error('unexpected');
    sessions++;
    return sessions===1?reply({accessToken:'fixture',user:{email:'fixture@example.invalid'}}):reply({error:'AUTH_BACKEND_UNAVAILABLE'},503);
  };
  const a=shared.page(fetch);await until(()=>sessions===1&&!a.nodes.get('signed-in').hidden);
  shared.page(fetch);await until(()=>sessions===2);await tick();await tick();
  assert.equal(a.nodes.get('signed-in').hidden,false);
});

test('another anonymous tab with no cookie does not cancel a pending login',async()=>{
  const gate=deferred();let sessions=0,logins=0;
  const shared=sharedContext();
  const fetch=async path=>{
    if(path==='/api/auth/session'){sessions++;return reply({error:'NO_SESSION'},401);}
    if(path==='/api/auth/login'){logins++;await gate.promise;return reply({accessToken:'fixture',user:{email:'fixture@example.invalid'}});}
    throw Error('unexpected');
  };
  const a=shared.page(fetch);await until(()=>sessions===1);a.login();await until(()=>logins===1);
  shared.page(fetch);await tick();gate.resolve();
  await until(()=>!a.nodes.get('signed-in').hidden);assert.equal(logins,1);
});

test('a cross-tab account change keeps the held-draft notice',async()=>{
  let sessions=0,logins=0;
  const shared=sharedContext();
  const fetch=async path=>{
    if(path==='/api/auth/session'){sessions++;return reply({accessToken:'old',user:{id:'11111111-1111-4111-8111-111111111111',email:'old@example.invalid'}});}
    if(path==='/api/auth/login'){logins++;return reply({accessToken:'new',user:{id:'22222222-2222-4222-8222-222222222222',email:'new@example.invalid'}});}
    throw Error('unexpected fixture request');
  };
  const a=shared.page(fetch),b=shared.page(fetch);
  await until(()=>sessions===2&&!a.nodes.get('signed-in').hidden&&!b.nodes.get('signed-in').hidden);
  a.nodes.get('new-title').value='synthetic draft';b.login();
  await until(()=>logins===1&&!a.nodes.get('signed-out').hidden);
  assert.match(a.nodes.get('login-status').textContent,/작성 내용.*보관/);
  assert.match(a.nodes.get('login-status').textContent,/다른 탭/);
  assert.doesNotMatch(a.nodes.get('login-status').textContent,/synthetic draft/);
});

test('a cross-tab logout keeps the held-draft notice',async()=>{
  const gate=deferred();let sessions=0,logouts=0;
  const shared=sharedContext();
  const fetch=async path=>{
    if(path==='/api/auth/session'){sessions++;return reply({accessToken:'old',user:{id:'11111111-1111-4111-8111-111111111111'}});}
    if(path==='/api/auth/logout'){logouts++;await gate.promise;return reply({ok:true});}
    throw Error('unexpected fixture request');
  };
  const a=shared.page(fetch),b=shared.page(fetch);
  await until(()=>sessions===2&&!a.nodes.get('signed-in').hidden&&!b.nodes.get('signed-in').hidden);
  a.nodes.get('new-title').value='synthetic draft';b.click('logout');await until(()=>logouts===1);
  try {
    assert.match(a.nodes.get('login-status').textContent,/작성 내용.*보관/);
    assert.match(a.nodes.get('login-status').textContent,/다른 탭.*로그아웃/);
    assert.doesNotMatch(a.nodes.get('login-status').textContent,/synthetic draft/);
  } finally {gate.resolve();}
  await until(()=>b.nodes.get('login-status').textContent.includes('서버 응답'));
  await tick();await tick();
  assert.match(a.nodes.get('login-status').textContent,/작성 내용.*보관/,'a later generation event must not erase the warning');
});

test('an orphaned pending state keeps the held-draft notice',async()=>{
  let sessions=0;const shared=sharedContext();
  const fetch=async path=>{if(path==='/api/auth/session'){sessions++;return reply({accessToken:'old',user:{id:'11111111-1111-4111-8111-111111111111'}});}throw Error('unexpected fixture request');};
  const a=shared.page(fetch),b=shared.page(fetch);
  await until(()=>sessions===2&&!a.nodes.get('signed-in').hidden&&!b.nodes.get('signed-in').hidden);
  a.nodes.get('new-title').value='synthetic draft';
  b.win.localStorage.setItem('aleph.auth.version.v1','pending:synthetic');
  await until(()=>a.nodes.get('signed-in').hidden);
  assert.match(a.nodes.get('login-status').textContent,/작성 내용.*보관/);
  assert.match(a.nodes.get('login-status').textContent,/완료 상태/);
});

test('a storage read failure keeps the held-draft notice',async()=>{
  let sessions=0;const shared=sharedContext();
  const fetch=async path=>{if(path==='/api/auth/session'){sessions++;return reply({accessToken:'old',user:{id:'11111111-1111-4111-8111-111111111111'}});}throw Error('unexpected fixture request');};
  const a=shared.page(fetch);await until(()=>sessions===1&&!a.nodes.get('signed-in').hidden);
  a.nodes.get('new-title').value='synthetic draft';a.setFailStorageReads(true);
  a.win.dispatchEvent(new Event('pageshow'));
  assert.match(a.nodes.get('login-status').textContent,/작성 내용.*보관/);
  assert.match(a.nodes.get('login-status').textContent,/저장 상태/);
});

test('a final coordination write failure keeps the held-draft notice',async()=>{
  const gate=deferred();let sessions=0,logins=0;const shared=sharedContext();
  const fetch=async path=>{
    if(path==='/api/auth/session'){sessions++;return reply({accessToken:'old',user:{id:'11111111-1111-4111-8111-111111111111'}});}
    if(path==='/api/auth/login'){logins++;await gate.promise;return reply({accessToken:'new',user:{id:'22222222-2222-4222-8222-222222222222'}});}
    throw Error('unexpected fixture request');
  };
  const a=shared.page(fetch);await until(()=>sessions===1&&!a.nodes.get('signed-in').hidden);
  a.nodes.get('new-title').value='synthetic draft';a.login();await until(()=>logins===1);
  a.setFailStorageWrites(true);gate.resolve();await until(()=>a.nodes.get('signed-in').hidden);
  assert.match(a.nodes.get('login-status').textContent,/작성 내용.*보관/);
  assert.match(a.nodes.get('login-status').textContent,/완료 상태/);
});

test('an unknown draft owner is not promised automatic recovery on a storage failure',async()=>{
  let sessions=0;const shared=sharedContext();
  const fetch=async path=>{if(path==='/api/auth/session'){sessions++;return reply({accessToken:'old',user:{email:'fixture@example.invalid'}});}throw Error('unexpected fixture request');};
  const a=shared.page(fetch);await until(()=>sessions===1&&!a.nodes.get('signed-in').hidden);
  a.nodes.get('new-title').value='synthetic draft';a.setFailStorageReads(true);
  a.win.dispatchEvent(new Event('pageshow'));
  assert.match(a.nodes.get('login-status').textContent,/자동 복구할 수 없습니다/);
  assert.match(a.nodes.get('login-status').textContent,/저장 상태/);
  assert.doesNotMatch(a.nodes.get('login-status').textContent,/synthetic draft/);
});

test('a logout from another tab preserves the draft notice during an active login',async()=>{
  const gate=deferred();let sessions=0,logins=0;const shared=sharedContext();
  const fetch=async path=>{
    if(path==='/api/auth/session'){sessions++;return reply({accessToken:'old',user:{id:'11111111-1111-4111-8111-111111111111'}});}
    if(path==='/api/auth/login'){logins++;await gate.promise;return reply({accessToken:'new',user:{id:'22222222-2222-4222-8222-222222222222'}});}
    if(path==='/api/auth/logout')return reply({ok:true});
    throw Error('unexpected fixture request');
  };
  const a=shared.page(fetch),b=shared.page(fetch);
  await until(()=>sessions===2&&!a.nodes.get('signed-in').hidden&&!b.nodes.get('signed-in').hidden);
  a.nodes.get('new-title').value='synthetic draft';a.login();await until(()=>logins===1);b.click('logout');
  try {
    assert.match(a.nodes.get('login-status').textContent,/작성 내용.*보관/);
    assert.match(a.nodes.get('login-status').textContent,/다른 탭.*로그아웃/);
  } finally {gate.resolve();}
  await until(()=>a.nodes.get('signed-in').hidden===false);
});

test('a later account change keeps the draft notice after this tab logs out',async()=>{
  let sessions=0,logins=0,logouts=0;const shared=sharedContext();
  const fetch=async path=>{
    if(path==='/api/auth/session'){sessions++;return reply({accessToken:'old',user:{id:'11111111-1111-4111-8111-111111111111'}});}
    if(path==='/api/auth/logout'){logouts++;return reply({ok:true});}
    if(path==='/api/auth/login'){logins++;return reply({accessToken:'new',user:{id:'22222222-2222-4222-8222-222222222222'}});}
    throw Error('unexpected fixture request');
  };
  const a=shared.page(fetch),b=shared.page(fetch);
  await until(()=>sessions===2&&!a.nodes.get('signed-in').hidden&&!b.nodes.get('signed-in').hidden);
  a.nodes.get('new-title').value='synthetic draft';a.click('logout');
  await until(()=>logouts===1&&!b.nodes.get('signed-out').hidden);
  b.login();await until(()=>logins===1);
  await until(()=>a.nodes.get('login-status').textContent.includes('다른 탭'));
  assert.match(a.nodes.get('login-status').textContent,/작성 내용.*보관/);
  assert.doesNotMatch(a.nodes.get('login-status').textContent,/synthetic draft/);
});

test('pagehide aborts this page’s active auth and queued login, and pageshow permits a fresh login',async()=>{
  let sessions=0,logins=0,activeSignal;
  const x=sharedContext().page((path,init)=>{
    if(path==='/api/auth/session'){
      sessions++;activeSignal=init.signal;
      return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true}));
    }
    if(path==='/api/auth/login'){logins++;return Promise.resolve(reply({accessToken:'new',user:{email:'new@example.invalid'}}));}
    throw Error('unexpected fixture request');
  });
  await until(()=>sessions===1);x.login();await tick();assert.equal(logins,0);
  x.win.dispatchEvent(new Event('pagehide'));await until(()=>activeSignal.aborted);await tick();await tick();
  assert.equal(logins,0,'queued login must not start after pagehide');
  x.win.dispatchEvent(new Event('pageshow'));x.login();
  await until(()=>logins===1&&!x.nodes.get('signed-in').hidden);
});

test('pagehide cancels only its own waiting ticket, not another page’s active authentication',async()=>{
  const pending=deferred();let firstSessions=0,secondLogins=0,firstSignal;
  const shared=sharedContext();
  const a=shared.page((path,init)=>{
    if(path==='/api/auth/session'){firstSessions++;firstSignal=init.signal;return pending.promise;}
    throw Error('unexpected fixture request');
  });
  await until(()=>firstSessions===1);
  const b=shared.page(path=>{
    if(path==='/api/auth/session')return Promise.resolve(reply({error:'NO_SESSION'},401));
    if(path==='/api/auth/login'){secondLogins++;return Promise.resolve(reply({accessToken:'new',user:{email:'new@example.invalid'}}));}
    throw Error('unexpected fixture request');
  });
  b.login();b.win.dispatchEvent(new Event('pagehide'));await tick();await tick();
  assert.equal(firstSignal.aborted,false,'other page’s network request must not be canceled');
  pending.resolve(reply({error:'NO_SESSION'},401));for(let i=0;i<20;i++)await tick();
  assert.equal(secondLogins,0,'waiting hidden page must not send credentials');
  b.win.dispatchEvent(new Event('pageshow'));b.login();await until(()=>secondLogins===1);
});

test('pageshow never starts a new auth before the aborted old transport settles',async()=>{
  const pending=deferred();let sessions=0,logins=0,oldSignal;
  const x=sharedContext().page((path,init)=>{
    if(path==='/api/auth/session'){sessions++;oldSignal=init.signal;return pending.promise;}
    if(path==='/api/auth/login'){logins++;return Promise.resolve(reply({accessToken:'new',user:{email:'new@example.invalid'}}));}
    throw Error('unexpected fixture request');
  });
  await until(()=>sessions===1);x.win.dispatchEvent(new Event('pagehide'));
  assert.equal(oldSignal.aborted,true);
  x.win.dispatchEvent(new Event('pageshow'));x.login();
  for(let i=0;i<20;i++)await tick();
  assert.equal(logins,0,'the held lock must not be released while an abort-ignoring fetch is unresolved');
  pending.resolve(reply({error:'NO_SESSION'},401));
  await until(()=>logins===1&&!x.nodes.get('signed-in').hidden);
});

test('pagehide during a rejected session refresh locks the vault and holds an unsaved draft',async()=>{
  let sessions=0,notesPosts=0,refreshSignal;
  const x=sharedContext().page((path,init)=>{
    if(path==='/api/auth/session'){
      sessions++;
      if(sessions===1)return Promise.resolve(reply({accessToken:'old',user:{email:'old@example.invalid',id:'11111111-1111-4111-8111-111111111111'}}));
      refreshSignal=init.signal;
      return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true}));
    }
    if(path==='/api/notes'&&init.method==='POST'){notesPosts++;return Promise.resolve(reply({error:'UNAUTHORIZED'},401));}
    if(path==='/api/notes')return Promise.resolve(reply([]));
    if(path==='/api/auth/logout')return Promise.resolve(reply({ok:true}));
    throw Error('unexpected fixture request');
  });
  await until(()=>sessions===1&&!x.nodes.get('signed-in').hidden&&typeof x.win.__authorize==='function');
  x.win.__authorize();x.nodes.get('new-title').value='fixture draft';x.nodes.get('new-body').value='fixture body';
  x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
  await until(()=>notesPosts===1&&sessions===2);x.win.dispatchEvent(new Event('pagehide'));await tick();await tick();
  assert.equal(refreshSignal.aborted,true);
  assert.equal(x.nodes.get('workspace').hidden,true);
  assert.equal(x.nodes.get('new-title').value,'');
  assert.equal(x.nodes.get('new-body').value,'');
  assert.match(x.nodes.get('login-status').textContent,/작성 내용.*보관/);
  x.win.dispatchEvent(new Event('pageshow'));x.click('logout');
});

test('BFCache return explains interrupted login without calling it a timeout and allows retry',async()=>{
  let sessions=0,logins=0,firstSignal;
  const x=sharedContext().page((path,init)=>{
    if(path==='/api/auth/session'){sessions++;return Promise.resolve(reply({error:'NO_SESSION'},401));}
    if(path==='/api/auth/login'){
      logins++;
      if(logins===1){firstSignal=init.signal;return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true}));}
      return Promise.resolve(reply({accessToken:'new',user:{email:'new@example.invalid'}}));
    }
    throw Error('unexpected fixture request');
  });
  await until(()=>sessions===1&&!x.nodes.get('signed-out').hidden);x.login();await until(()=>logins===1);
  x.win.dispatchEvent(new Event('pagehide'));assert.equal(firstSignal.aborted,true);await tick();
  x.win.dispatchEvent(new Event('pageshow'));
  assert.match(x.nodes.get('login-status').textContent,/화면 이동.*취소/);
  assert.match(x.nodes.get('login-status').textContent,/서버.*확인/);
  assert.doesNotMatch(x.nodes.get('login-status').textContent,/시간.*초과|로그인 중/);
  x.login();await until(()=>logins===2&&!x.nodes.get('signed-in').hidden);
});

test('pagehide aborting a refresh after a protected 401 locks the rejected session and preserves its draft',async()=>{
  let sessions=0,posts=0,logins=0;
  const owner='11111111-1111-4111-8111-111111111111';
  const x=sharedContext().page((path,init)=>{
    if(path==='/api/auth/session'){
      sessions++;
      if(sessions===1)return Promise.resolve(reply({accessToken:'old',user:{email:'synthetic@example.invalid',id:owner}}));
      return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true}));
    }
    if(path==='/api/auth/login'){logins++;return Promise.resolve(reply({accessToken:'new',user:{email:'synthetic@example.invalid',id:owner}}));}
    if(path==='/api/auth/logout')return Promise.resolve(reply({ok:true}));
    if(path==='/api/notes'&&init.method==='POST'){posts++;return Promise.resolve(reply({error:'UNAUTHORIZED'},401));}
    if(path==='/api/notes')return Promise.resolve(reply([]));
    throw Error('unexpected fixture request');
  });
  await until(()=>sessions===1&&!x.nodes.get('signed-in').hidden&&typeof x.win.__authorize==='function');
  x.win.__authorize();x.nodes.get('new-title').value='fixture draft';x.nodes.get('new-body').value='fixture body';
  x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
  await until(()=>posts===1&&sessions===2);
  try {
    x.win.dispatchEvent(new Event('pagehide'));await tick();await tick();
    x.win.dispatchEvent(new Event('pageshow'));for(let i=0;i<10;i++)await tick();
    assert.equal(x.nodes.get('workspace').hidden,true,'server-rejected credentials must not leave the old vault visible');
    assert.equal(x.nodes.get('signed-out').hidden,false);
    assert.equal(x.nodes.get('new-title').value,'');
    assert.match(x.nodes.get('login-status').textContent,/작성 내용.*보관/);
    assert.match(x.nodes.get('login-status').textContent,/서버.*확인/);
    x.login();await until(()=>logins===1&&!x.nodes.get('signed-in').hidden);
    assert.equal(x.nodes.get('new-title').value,'','the held draft must remain hidden before device verification');
    x.win.__authorize();
    assert.equal(x.nodes.get('new-title').value,'fixture draft');
    assert.equal(x.nodes.get('new-body').value,'fixture body');
  } finally {x.win.dispatchEvent(new Event('pageshow'));x.click('logout');}
});

test('interrupted initial session restoration explains the cancellation and permits explicit login',async()=>{
  let sessions=0,logins=0,initialSignal;
  const x=sharedContext().page((path,init)=>{
    if(path==='/api/auth/session'){
      sessions++;initialSignal=init.signal;
      return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true}));
    }
    if(path==='/api/auth/login'){logins++;return Promise.resolve(reply({accessToken:'new',user:{email:'synthetic@example.invalid'}}));}
    throw Error('unexpected fixture request');
  });
  await until(()=>sessions===1);x.win.dispatchEvent(new Event('pagehide'));assert.equal(initialSignal.aborted,true);
  await tick();x.win.dispatchEvent(new Event('pageshow'));
  assert.match(x.nodes.get('login-status').textContent,/복원.*취소/);
  assert.match(x.nodes.get('login-status').textContent,/서버.*확인/);
  assert.doesNotMatch(x.nodes.get('login-status').textContent,/시간.*초과/);
  x.login();await until(()=>logins===1&&!x.nodes.get('signed-in').hidden);
});

test('pagehide without a rejected request preserves an otherwise valid vault',async()=>{
  let sessions=0;
  const x=sharedContext().page((path,init)=>{
    if(path==='/api/auth/session'){sessions++;return Promise.resolve(reply({accessToken:'valid',user:{email:'synthetic@example.invalid',id:'11111111-1111-4111-8111-111111111111'}}));}
    if(path==='/api/auth/logout')return Promise.resolve(reply({ok:true}));
    if(path==='/api/notes')return Promise.resolve(reply([]));
    throw Error('unexpected fixture request');
  });
  await until(()=>sessions===1&&!x.nodes.get('signed-in').hidden&&typeof x.win.__authorize==='function');
  x.win.__authorize();x.nodes.get('new-title').value='fixture draft';
  try {
    x.win.dispatchEvent(new Event('pagehide'));await tick();x.win.dispatchEvent(new Event('pageshow'));await tick();
    assert.equal(x.nodes.get('workspace').hidden,false);
    assert.equal(x.nodes.get('new-title').value,'fixture draft');
  } finally {x.click('logout');}
});

test('an aborted old refresh cannot invalidate a newer login started after pageshow',async()=>{
  let sessions=0,posts=0,logins=0;
  const x=sharedContext().page((path,init)=>{
    if(path==='/api/auth/session'){
      sessions++;
      if(sessions===1)return Promise.resolve(reply({accessToken:'old',user:{email:'old@example.invalid'}}));
      return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true}));
    }
    if(path==='/api/auth/login'){logins++;return Promise.resolve(reply({accessToken:'new',user:{email:'new@example.invalid'}}));}
    if(path==='/api/auth/logout')return Promise.resolve(reply({ok:true}));
    if(path==='/api/notes'&&init.method==='POST'){posts++;return Promise.resolve(reply({error:'UNAUTHORIZED'},401));}
    if(path==='/api/notes')return Promise.resolve(reply([]));
    throw Error('unexpected fixture request');
  });
  await until(()=>sessions===1&&!x.nodes.get('signed-in').hidden&&typeof x.win.__authorize==='function');
  x.win.__authorize();x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
  await until(()=>posts===1&&sessions===2);
  try {
    x.win.dispatchEvent(new Event('pagehide'));x.win.dispatchEvent(new Event('pageshow'));x.login();
    await until(()=>logins===1&&x.nodes.get('session-label').textContent.includes('new@example.invalid'));
    assert.equal(x.nodes.get('signed-in').hidden,false);
    x.win.__authorize();assert.equal(x.nodes.get('workspace').hidden,false);
  } finally {x.click('logout');}
});

test('a newer pending login cannot leave a rejected old vault visible after pagehide',async()=>{
  const login=deferred();let sessions=0,posts=0,logins=0;
  const x=sharedContext().page((path,init)=>{
    if(path==='/api/auth/session'){
      sessions++;
      if(sessions===1)return Promise.resolve(reply({accessToken:'old',user:{email:'old@example.invalid'}}));
      return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true}));
    }
    if(path==='/api/auth/login'){logins++;return login.promise;}
    if(path==='/api/auth/logout')return Promise.resolve(reply({ok:true}));
    if(path==='/api/notes'&&init.method==='POST'){posts++;return Promise.resolve(reply({error:'UNAUTHORIZED'},401));}
    if(path==='/api/notes')return Promise.resolve(reply([]));
    throw Error('unexpected fixture request');
  });
  await until(()=>sessions===1&&!x.nodes.get('signed-in').hidden&&typeof x.win.__authorize==='function');
  x.win.__authorize();x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
  await until(()=>posts===1&&sessions===2);
  try {
    x.win.dispatchEvent(new Event('pagehide'));x.win.dispatchEvent(new Event('pageshow'));x.login();
    await until(()=>logins===1);await tick();
    assert.equal(x.nodes.get('workspace').hidden,true,'a rejected old vault must remain locked while the new login is pending');
    assert.match(x.nodes.get('login-status').textContent,/로그인 중/);
  } finally {login.resolve(reply({accessToken:'new',user:{email:'new@example.invalid'}}));}
  await until(()=>x.nodes.get('session-label').textContent.includes('new@example.invalid'));
  x.click('logout');
});

for (const outcome of ['rejected', 'network failure', 'timeout']) test(`a failed newer login (${outcome}) cannot retain a rejected old session`,async()=>{
  const login=deferred();let sessions=0,posts=0,logins=0;
  const owner={email:'old@example.invalid',id:'11111111-1111-4111-8111-111111111111'};
  const x=sharedContext({manualTimers:outcome==='timeout'}).page((path,init)=>{
    if(path==='/api/auth/session'){
      sessions++;
      if(sessions===1)return Promise.resolve(reply({accessToken:'old',user:owner}));
      return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true}));
    }
    if(path==='/api/auth/login'){
      logins++;
      if(logins===1)return login.promise.then(()=>{if(outcome==='network failure')throw Error('fixture network error');return reply({error:'LOGIN_FAILED'},401);});
      return Promise.resolve(reply({accessToken:'new',user:owner}));
    }
    if(path==='/api/auth/logout')return Promise.resolve(reply({ok:true}));
    if(path==='/api/notes'&&init.method==='POST'){posts++;return Promise.resolve(reply({error:'UNAUTHORIZED'},401));}
    if(path==='/api/notes')return Promise.resolve(reply([]));
    throw Error('unexpected fixture request');
  });
  await until(()=>sessions===1&&!x.nodes.get('signed-in').hidden&&typeof x.win.__authorize==='function');
  x.win.__authorize();x.nodes.get('new-title').value='synthetic draft';
  x.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
  await until(()=>posts===1&&sessions===2);
  try {
    x.win.dispatchEvent(new Event('pagehide'));x.win.dispatchEvent(new Event('pageshow'));x.login();
    await until(()=>logins===1);await tick();
    assert.equal(x.nodes.get('signed-in').hidden,true,'rejected session must be removed while a newer login is pending');
    assert.equal(x.nodes.get('workspace').hidden,true);
    assert.match(x.nodes.get('login-status').textContent,/로그인 중/);
    if(outcome==='timeout')x.fireTimers();
    login.resolve();
    await until(()=>/일치하지|연결할 수 없|시간.*초과/.test(x.nodes.get('login-status').textContent));
    assert.equal(x.nodes.get('signed-in').hidden,true);
    assert.match(x.nodes.get('login-status').textContent,/작성 내용.*보관/);
    x.login();await until(()=>logins===2&&!x.nodes.get('signed-in').hidden);
    x.win.__authorize();assert.equal(x.nodes.get('new-title').value,'synthetic draft');
  } finally {login.resolve();x.click('logout');}
});

test('a login submitted while another tab finishes authentication is not lost', async () => {
  const firstSession = deferred();
  let sessions = 0, logins = 0;
  const shared = sharedContext();
  const fetch = async path => {
    if (path === '/api/auth/session') {
      sessions++;
      if (sessions === 1) return firstSession.promise;
      return reply({error:'NO_SESSION'}, 401);
    }
    if (path === '/api/auth/login') {
      logins++;
      return reply({accessToken:'fixture-new', user:{email:'fixture@example.invalid'}});
    }
    throw Error('unexpected fixture request');
  };
  shared.page(fetch);
  await until(() => sessions === 1);
  const next = shared.page(fetch);
  next.login();
  firstSession.resolve(reply({error:'NO_SESSION'}, 401));
  for (let i = 0; i < 50; i++) await tick();
  assert.equal(logins, 1, 'the explicit login must be sent after the earlier request completes');
  assert.equal(next.nodes.get('signed-in').hidden, false);
});
const fallbackUser={id:'11111111-1111-4111-8111-111111111111',email:'fixture@example.invalid'};

test('fallback audit: queued logout plus pagehide blocks a later automatic session',async()=>{
  const pending=deferred();let sessions=0,logouts=0;
  const shared=sharedContext({locks:false,storageAvailable:true});
  const fetch=async(path,init={})=>{
    if(path==='/api/auth/session'){
      sessions++;if(sessions===2)return pending.promise;
      return reply({accessToken:'synthetic',user:fallbackUser});
    }
    if(path==='/api/auth/logout'){logouts++;return reply({ok:true});}
    if(path==='/api/notes'&&init.method==='POST')return reply({error:'UNAUTHORIZED'},401);
    if(path==='/api/notes')return reply([]);
    throw Error('unexpected fixture route');
  };
  const a=shared.page(fetch);
  try {
    await until(()=>sessions===1&&!a.nodes.get('signed-in').hidden&&typeof a.win.__authorize==='function');
    a.win.__authorize();a.nodes.get('new-title').value='fixture draft';
    a.nodes.get('create-form').dispatchEvent(new Event('submit',{cancelable:true}));
    await until(()=>sessions===2);a.click('logout');a.win.dispatchEvent(new Event('pagehide'));
    pending.resolve(reply({accessToken:'synthetic',user:fallbackUser}));
    for(let i=0;i<20;i++)await tick();const b=shared.page(fetch);
    for(let i=0;i<20;i++)await tick();
    assert.equal(logouts,0);assert.equal(sessions,2,'no automatic session request may follow a retained logout intent');
    assert.equal(b.nodes.get('signed-in').hidden,true);
  } finally {pending.resolve(reply({error:'NO_SESSION'},401));}
});

test('fallback audit: failed deliberate login does not clear a previous logout intent',async()=>{
  let sessions=0,logins=0;
  const shared=sharedContext({locks:false,storageAvailable:true});
  const fetch=async path=>{
    if(path==='/api/auth/session'){sessions++;return reply({accessToken:'synthetic',user:fallbackUser});}
    if(path==='/api/auth/logout')throw Error('fixture network outage');
    if(path==='/api/auth/login'){logins++;return reply({error:'LOGIN_FAILED'},401);}
    throw Error('unexpected fixture route');
  };
  const a=shared.page(fetch);await until(()=>sessions===1&&!a.nodes.get('signed-in').hidden);
  a.click('logout');await until(()=>a.nodes.get('login-status').textContent.includes('서버'));
  a.login();await until(()=>logins===1);for(let i=0;i<15;i++)await tick();
  const b=shared.page(fetch);for(let i=0;i<20;i++)await tick();
  assert.equal(sessions,1,'failed login cannot approve the pending logout');
  assert.equal(b.nodes.get('signed-in').hidden,true);
});

test('fallback audit: successful deliberate login allows a later automatic session',async()=>{
  let sessions=0,logins=0;
  const shared=sharedContext({locks:false,storageAvailable:true});
  const fetch=async path=>{
    if(path==='/api/auth/session'){sessions++;return reply({accessToken:'synthetic',user:fallbackUser});}
    if(path==='/api/auth/logout')throw Error('fixture network outage');
    if(path==='/api/auth/login'){logins++;return reply({accessToken:'synthetic-new',user:fallbackUser});}
    throw Error('unexpected fixture route');
  };
  const a=shared.page(fetch);await until(()=>sessions===1&&!a.nodes.get('signed-in').hidden);
  a.click('logout');await until(()=>a.nodes.get('login-status').textContent.includes('서버'));
  a.login();await until(()=>logins===1&&!a.nodes.get('signed-in').hidden);
  const b=shared.page(fetch);await until(()=>sessions===2&&!b.nodes.get('signed-in').hidden);
});

test('fallback audit: later logout during a different tab login is not acknowledged by the older login',async()=>{
  const pending=deferred();let sessions=0,logins=0,logouts=0;
  const shared=sharedContext({locks:false,storageAvailable:true,deliverStorageEvents:false});
  const a=shared.page(async path=>{
    if(path==='/api/auth/session'){sessions++;return reply({error:'NO_SESSION'},401);}
    if(path==='/api/auth/login'){logins++;return pending.promise;}
    throw Error('unexpected fixture route');
  });
  const b=shared.page(async path=>{
    if(path==='/api/auth/session'){sessions++;return reply({accessToken:'synthetic',user:fallbackUser});}
    if(path==='/api/auth/logout'){logouts++;return reply({ok:true});}
    throw Error('unexpected fixture route');
  });
  try {
    await until(()=>sessions===2&&!b.nodes.get('signed-in').hidden);a.login();await until(()=>logins===1);
    b.click('logout');await until(()=>logouts===1);pending.resolve(reply({accessToken:'synthetic-new',user:fallbackUser}));
    for(let i=0;i<25;i++)await tick();
    const c=shared.page(async path=>{if(path==='/api/auth/session'){sessions++;return reply({accessToken:'synthetic-old',user:fallbackUser});}throw Error('unexpected fixture route');});
    for(let i=0;i<20;i++)await tick();
    assert.equal(c.nodes.get('signed-in').hidden,true,'the newer logout must not be lost by an older login response');
    assert.equal(sessions,2);
  } finally {pending.resolve(reply({error:'LOGIN_FAILED'},401));}
});

test('fallback audit: delayed session cannot reopen after another tab requests logout',async()=>{
  const pending=deferred();let sessions=0,logouts=0;
  const shared=sharedContext({locks:false,storageAvailable:true,deliverStorageEvents:false});
  const a=shared.page(async path=>{
    if(path==='/api/auth/session'){sessions++;return reply({accessToken:'synthetic',user:fallbackUser});}
    if(path==='/api/auth/logout'){logouts++;return reply({ok:true});}
    throw Error('unexpected fixture route');
  });
  await until(()=>sessions===1&&!a.nodes.get('signed-in').hidden);
  const b=shared.page(async path=>{if(path==='/api/auth/session'){sessions++;return pending.promise;}throw Error('unexpected fixture route');});
  try {
    await until(()=>sessions===2);a.click('logout');await until(()=>logouts===1);
    pending.resolve(reply({accessToken:'synthetic-old',user:fallbackUser}));for(let i=0;i<25;i++)await tick();
    assert.equal(b.nodes.get('signed-in').hidden,true,'a delayed session must recheck the logout intent before opening');
  } finally {pending.resolve(reply({error:'NO_SESSION'},401));}
});

test('fallback audit: failed persistent marker storage warns that reload can reopen session',async()=>{
  let sessions=0;
  const shared=sharedContext({locks:false,storageAvailable:true});
  const a=shared.page(async path=>{
    if(path==='/api/auth/session'){sessions++;return reply({accessToken:'synthetic',user:fallbackUser});}
    if(path==='/api/auth/logout')throw Error('fixture network failure');
    throw Error('unexpected fixture route');
  });
  await until(()=>sessions===1&&!a.nodes.get('signed-in').hidden);a.setFailStorageWrites(true);
  a.click('logout');await until(()=>a.nodes.get('login-status').textContent.includes('확인하지 못'));
  assert.match(a.nodes.get('login-status').textContent,/새로고침.*다시 열릴/);
});

test('fallback audit: unreadable successful login cannot approve a prior logout',async()=>{
  let sessions=0,logins=0;
  const shared=sharedContext({locks:false,storageAvailable:true});
  const fetch=async path=>{
    if(path==='/api/auth/session'){sessions++;return reply({accessToken:'synthetic',user:fallbackUser});}
    if(path==='/api/auth/logout')throw Error('fixture outage');
    if(path==='/api/auth/login'){logins++;return new Response('{bad',{status:200,headers:{'Content-Type':'application/json'}});}
    throw Error('unexpected fixture route');
  };
  const a=shared.page(fetch);await until(()=>sessions===1&&!a.nodes.get('signed-in').hidden);
  a.click('logout');await until(()=>a.nodes.get('login-status').textContent.includes('확인하지 못'));
  a.login();await until(()=>logins===1);for(let i=0;i<20;i++)await tick();
  const b=shared.page(fetch);for(let i=0;i<20;i++)await tick();
  assert.equal(sessions,1,'an unreadable response cannot approve the logout intent');
  assert.equal(b.nodes.get('signed-in').hidden,true);
});

test('fallback audit: denied storage read at login completion must not approve a prior logout',async()=>{
  const pending=deferred();let sessions=0,logins=0;
  const shared=sharedContext({locks:false,storageAvailable:true});
  const fetch=async path=>{
    if(path==='/api/auth/session'){sessions++;return reply({accessToken:'synthetic',user:fallbackUser});}
    if(path==='/api/auth/logout')throw Error('fixture outage');
    if(path==='/api/auth/login'){logins++;return pending.promise;}
    throw Error('unexpected fixture route');
  };
  const a=shared.page(fetch);
  try {
    await until(()=>sessions===1&&!a.nodes.get('signed-in').hidden);
    a.click('logout');await until(()=>a.nodes.get('login-status').textContent.includes('확인하지 못'));
    a.login();await until(()=>logins===1);a.setFailStorageReads(true);
    pending.resolve(reply({accessToken:'synthetic-new',user:fallbackUser}));for(let i=0;i<20;i++)await tick();
    assert.equal(a.nodes.get('signed-in').hidden,true,'login cannot safely apply while intent storage cannot be rechecked');
    const b=shared.page(fetch);for(let i=0;i<20;i++)await tick();
    assert.equal(sessions,1);assert.equal(b.nodes.get('signed-in').hidden,true);
  } finally {pending.resolve(reply({error:'LOGIN_FAILED'},401));}
});
for(const [beforeLocks,afterLocks] of [[false,true],[true,false]]) test(`fallback audit: unconfirmed logout survives changing locks from ${beforeLocks} to ${afterLocks}`,async()=>{
  let sessions=0;
  const shared=sharedContext({locks:true});
  const fetch=async path=>{
    if(path==='/api/auth/session'){sessions++;return reply({accessToken:'synthetic',user:fallbackUser});}
    if(path==='/api/auth/logout')throw Error('fixture outage');
    throw Error('unexpected fixture route');
  };
  const a=shared.page(fetch,{pageLocks:beforeLocks});await until(()=>sessions===1&&!a.nodes.get('signed-in').hidden);
  a.click('logout');await until(()=>a.nodes.get('login-status').textContent.includes('확인하지 못'));
  const b=shared.page(fetch,{pageLocks:afterLocks});for(let i=0;i<20;i++)await tick();
  assert.equal(sessions,1,'capability change cannot bypass an unconfirmed logout');
  assert.equal(b.nodes.get('signed-in').hidden,true);
});

for(const deliverStorageEvents of [true,false]) test(`a no-lock tab checks a lock-enabled tab's logout ${deliverStorageEvents?'on storage notification':'on page return'}`,async()=>{
  const gate=deferred();let sessions=0,logouts=0;
  const shared=sharedContext({deliverStorageEvents});
  const fetch=async path=>{
    if(path==='/api/auth/session'){sessions++;return reply({accessToken:'fixture',user:fallbackUser});}
    if(path==='/api/auth/logout'){logouts++;return gate.promise;}
    throw Error('unexpected fixture route');
  };
  const locked=shared.page(fetch,{pageLocks:true});
  await until(()=>sessions===1&&!locked.nodes.get('signed-in').hidden);
  const unlocked=shared.page(fetch,{pageLocks:false});
  await until(()=>sessions===2&&!unlocked.nodes.get('signed-in').hidden);
  try {
    locked.click('logout');await until(()=>logouts===1);
    if(!deliverStorageEvents)unlocked.win.dispatchEvent(new Event('pageshow'));
    await tick();await tick();
    assert.equal(unlocked.nodes.get('signed-in').hidden,true,'the prior vault must be locked when a logout is observed');
  } finally {gate.resolve(reply({ok:true}));await tick();await tick();}
});
test('redteam: a login must not open when an acknowledgement becomes stale in flight',async()=>{
 const gate=deferred();let logins=0;const shared=sharedContext({locks:false,storageAvailable:true,deliverStorageEvents:false});
 const fetch=async path=>{if(path==='/api/auth/session')return reply({error:'NO_SESSION'},401);if(path==='/api/auth/login'){logins++;return gate.promise;}throw Error('unexpected fixture request');};
 const a=shared.page(fetch);await tick();await tick();
 const current='b'.repeat(32),older='a'.repeat(32);
 a.win.localStorage.setItem('aleph.auth.fallback.intent.v1',current);
 a.win.localStorage.setItem('aleph.auth.fallback.ack.v1',JSON.stringify([current,'']));
 a.login();await until(()=>logins===1);
 a.win.localStorage.setItem('aleph.auth.fallback.ack.v1',JSON.stringify([older,'']));
 gate.resolve(reply({accessToken:'fixture',user:{id:'11111111-1111-4111-8111-111111111111'}}));
 for(let i=0;i<20;i++)await tick();
 assert.equal(a.nodes.get('signed-in').hidden,true,'stale acknowledgement must prevent applying an in-flight login');
});

test('fallback coordination stores only random nonsecret state',async()=>{
  let sessions=0,logins=0;
  const shared=sharedContext({locks:false,storageAvailable:true});
  const page=shared.page(async path=>{
    if(path==='/api/auth/session'){sessions++;return reply({accessToken:'fixture-access',user:fallbackUser});}
    if(path==='/api/auth/logout')throw Error('fixture outage');
    if(path==='/api/auth/login'){logins++;return reply({accessToken:'fixture-access-new',user:fallbackUser});}
    throw Error('unexpected fixture route');
  });
  await until(()=>sessions===1&&!page.nodes.get('signed-in').hidden);
  page.click('logout');await until(()=>page.nodes.get('login-status').textContent.includes('확인하지 못'));
  page.login();await until(()=>logins===1&&!page.nodes.get('signed-in').hidden);
  const probes=shared.writes.filter(([key])=>key.startsWith('aleph.auth.probe.v1:'));
  assert.ok(probes.length>0);
  for(const [key,value] of probes)assert.equal(key,'aleph.auth.probe.v1:'+value);
  const coordination=shared.writes.filter(([key])=>!key.startsWith('aleph.auth.probe.v1:'));
  assert.deepEqual(coordination.map(([key])=>key),['aleph.auth.fallback.intent.v1','aleph.auth.fallback.ack.v1']);
  assert.match(coordination[0][1],/^[a-f0-9]{32}$/u);
  assert.deepEqual(JSON.parse(coordination[1][1]),[coordination[0][1],'']);
  assert.doesNotMatch(JSON.stringify(shared.writes),/fixture|@|password|proof|token/iu);
});

for(const locks of [true,false]) test(`without persistent storage a new page requires an explicit login even with locks=${locks}`,async()=>{
  let sessions=0,logins=0;
  const shared=sharedContext({locks,storageAvailable:false});
  const page=shared.page(async path=>{
    if(path==='/api/auth/session'){sessions++;return reply({accessToken:'fixture-old',user:fallbackUser});}
    if(path==='/api/auth/login'){logins++;return reply({accessToken:'fixture-new',user:fallbackUser});}
    throw Error('unexpected fixture route');
  });
  for(let i=0;i<20;i++)await tick();
  assert.equal(sessions,0,'a new page cannot prove a prior logout did not occur');
  assert.equal(page.nodes.get('signed-in').hidden,true);
  assert.match(page.nodes.get('login-status').textContent,/자동.*복원.*로그인/);
  page.login();await until(()=>logins===1&&!page.nodes.get('signed-in').hidden);
});

test('a new page with read-only storage requires deliberate login before session restore',async()=>{
  let sessions=0,logins=0;
  const shared=sharedContext({locks:false,storageAvailable:true});
  const page=shared.page(async path=>{
    if(path==='/api/auth/session'){sessions++;return reply({accessToken:'fixture-old',user:fallbackUser});}
    if(path==='/api/auth/login'){logins++;return reply({accessToken:'fixture-new',user:fallbackUser});}
    throw Error('unexpected fixture route');
  },{storageWritesBlocked:true});
  for(let i=0;i<20;i++)await tick();
  assert.equal(sessions,0,'read-only storage cannot persist a logout');
  assert.equal(page.nodes.get('signed-in').hidden,true);
  page.login();await until(()=>logins===1&&!page.nodes.get('signed-in').hidden);
});
