import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initDeviceAccess } from '../public/device.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(predicate){for(let i=0;i<40;i++){if(predicate())return;await tick();}throw Error('timed out waiting for test step');}
const ok=data=>({ok:true,json:async()=>data});
const proof={schema:'aleph.device.proof.v1',approved:true,proof:'synthetic-proof',expiresInSeconds:60};
const approved={registration:'approved',verified:false,canOpenVault:false};

function setup(t,handler){
  const saved={};
  for(const key of ['window','document','navigator','fetch'])saved[key]=Object.getOwnPropertyDescriptor(globalThis,key);
  t.after(()=>{for(const [key,value] of Object.entries(saved)){
    if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];
  }});
  const nodes=new Map();
  for(const id of ['device-state','device-detail','device-enroll','device-unlock','device-refresh','device-panel','pwa-state','pwa-install']){
    const el=new EventTarget();Object.assign(el,{hidden:false,disabled:false,textContent:''});nodes.set(id,el);
  }
  const win=new EventTarget();
  win.PublicKeyCredential=class {};
  win.SimpleWebAuthnBrowser={startRegistration:async()=>({}),startAuthentication:async()=>({})};
  win.matchMedia=()=>({matches:false});
  Object.defineProperty(globalThis,'window',{configurable:true,value:win});
  Object.defineProperty(globalThis,'document',{configurable:true,value:{getElementById:id=>nodes.get(id),readyState:'complete'}});
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{}});
  const calls=[];
  Object.defineProperty(globalThis,'fetch',{configurable:true,value:async url=>{
    const action=new URL(url,'http://fixture.invalid').searchParams.get('action');calls.push(action);
    return handler(action,calls);
  }});
  let token='synthetic-session-a';const opened=[];let locked=0;
  const access=initDeviceAccess({getAccessToken:()=>token,onAuthorized:(...args)=>opened.push(args),onLocked:()=>locked++});
  return {nodes,win,calls,opened,access,get locked(){return locked;},setToken:value=>{token=value;}};
}
const click=node=>node.dispatchEvent(new Event('click'));

test('late verification success after an identity change cannot authorize the new session',async t=>{
  const pending=deferred();
  const x=setup(t,action=>action==='status'?ok(approved):action==='assertion-verify'?pending.promise:ok({}));
  await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
  click(x.nodes.get('device-unlock'));
  await until(()=>x.calls.includes('assertion-verify'));
  x.setToken('synthetic-session-b');x.win.dispatchEvent(new Event('aleph:identity'));
  await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
  pending.resolve(ok(proof));await tick();await tick();
  assert.equal(x.opened.length,0);
  assert.equal(x.nodes.get('device-state').textContent,'등록 기기 · 재인증 필요');
});

test('late failure from the old session cannot lock a newer successful authentication',async t=>{
  const pending=deferred();let count=0;
  const x=setup(t,action=>action==='status'?ok(approved):action==='assertion-verify'&&++count===1?pending.promise:ok(action==='assertion-verify'?proof:{}));
  await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
  click(x.nodes.get('device-unlock'));await until(()=>count===1);
  x.setToken('synthetic-session-b');x.win.dispatchEvent(new Event('aleph:identity'));
  await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
  click(x.nodes.get('device-unlock'));await until(()=>x.opened.length===1);
  const locks=x.locked;
  pending.reject(Error('old network failure'));await tick();await tick();
  assert.equal(x.locked,locks);
  assert.equal(x.nodes.get('device-state').textContent,'인증기 확인 완료');
});

test('older status responses cannot overwrite a completed authentication',async t=>{
  const pending=deferred();let statuses=0;
  const x=setup(t,action=>action==='status'&&++statuses===2?pending.promise:ok(action==='status'?approved:action==='assertion-verify'?proof:{}));
  await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
  void x.access.status();await until(()=>statuses===2);
  click(x.nodes.get('device-unlock'));await until(()=>x.opened.length===1);
  pending.resolve(ok(approved));await tick();await tick();
  assert.equal(x.nodes.get('device-state').textContent,'인증기 확인 완료');
  assert.equal(x.nodes.get('device-unlock').hidden,true);
});

test('a canceled registration stops before requesting the next ceremony step',async t=>{
  const pending=deferred();
  const x=setup(t,action=>action==='registration-options'?pending.promise:ok(action==='status'?approved:{}));
  await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
  let browserInvocations=0;x.win.SimpleWebAuthnBrowser.startRegistration=async()=>{browserInvocations++;return {};};
  click(x.nodes.get('device-enroll'));await until(()=>x.calls.includes('registration-options'));
  x.setToken(null);x.win.dispatchEvent(new Event('aleph:identity'));
  pending.resolve(ok({}));await tick();await tick();
  assert.equal(browserInvocations,0);
  assert.equal(x.opened.length,0);
});

test('each pending authenticator step stops when its session is replaced',async t=>{
  for(const step of ['registration-options','registration-prompt','registration-verify','assertion-options','authentication-prompt','assertion-verify']){
    await t.test(step,async t=>{
      const pending=deferred();let reached=false;
      const x=setup(t,action=>{
        if(action===step){reached=true;return pending.promise;}
        return ok(action==='status'?approved:action==='registration-verify'?{registration:'approved'}:action==='assertion-verify'?proof:{});
      });
      x.win.SimpleWebAuthnBrowser.startRegistration=async()=>{
        if(step==='registration-prompt'){reached=true;return pending.promise;}
        return {};
      };
      x.win.SimpleWebAuthnBrowser.startAuthentication=async()=>{
        if(step==='authentication-prompt'){reached=true;return pending.promise;}
        return {};
      };
      await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
      click(x.nodes.get('device-enroll'));await until(()=>reached);
      x.setToken(null);x.win.dispatchEvent(new Event('aleph:identity'));
      const callCount=x.calls.length,locked=x.locked;
      pending.resolve(step.endsWith('prompt')?{}:ok(step==='registration-verify'?{registration:'approved'}:step==='assertion-verify'?proof:{}));
      await tick();await tick();
      assert.equal(x.calls.length,callCount,'old ceremony must not send subsequent requests');
      assert.equal(x.locked,locked,'old ceremony must not lock the current state again');
      assert.equal(x.opened.length,0);
      assert.equal(x.nodes.get('device-state').textContent,'로그인 전');
    });
  }
});

test('newer status response wins if two checks complete out of order',async t=>{
  const first=deferred();let count=0;
  const x=setup(t,action=>{
    assert.equal(action,'status');
    return ++count===1?first.promise:ok({registration:'pending'});
  });
  await until(()=>count===1);
  await x.access.status();
  assert.equal(x.nodes.get('device-state').textContent,'승인 대기');
  first.resolve(ok(approved));await tick();await tick();
  assert.equal(x.nodes.get('device-state').textContent,'승인 대기');
});

test('current valid authentication opens once and current failure stays locked',async t=>{
  let fail=false;
  const x=setup(t,action=>{
    if(action==='assertion-verify'&&fail)return {ok:false,status:403,json:async()=>({error:'DENIED'})};
    return ok(action==='status'?approved:action==='assertion-verify'?proof:{});
  });
  await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
  click(x.nodes.get('device-unlock'));await until(()=>x.opened.length===1);
  assert.equal(x.nodes.get('device-state').textContent,'인증기 확인 완료');
  x.win.dispatchEvent(new Event('aleph:identity'));
  await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
  fail=true;const locked=x.locked;
  click(x.nodes.get('device-unlock'));await until(()=>x.locked>locked);
  await until(()=>!x.nodes.get('device-unlock').disabled);
  assert.equal(x.opened.length,1);
  assert.equal(x.nodes.get('device-state').textContent,'등록 기기 · 재인증 필요');
});

test('silent token replacement invalidates a late verification success',async t=>{
  const pending=deferred();
  const x=setup(t,action=>action==='status'?ok(approved):action==='assertion-verify'?pending.promise:ok({}));
  await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
  click(x.nodes.get('device-unlock'));await until(()=>x.calls.includes('assertion-verify'));
  x.setToken('synthetic-session-b');
  pending.resolve(ok(proof));await tick();await tick();
  assert.equal(x.opened.length,0);
  assert.notEqual(x.nodes.get('device-state').textContent,'인증기 확인 완료');
  await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
  assert.equal(x.nodes.get('device-unlock').disabled,false);
});

test('silent logout invalidates a late verification failure and restores logged-out controls',async t=>{
  const pending=deferred();
  const x=setup(t,action=>action==='status'?ok(approved):action==='assertion-verify'?pending.promise:ok({}));
  await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
  click(x.nodes.get('device-unlock'));await until(()=>x.calls.includes('assertion-verify'));
  const locked=x.locked;
  x.setToken(null);pending.reject(Error('old network failure'));await tick();await tick();
  assert.equal(x.locked,locked);
  await until(()=>x.nodes.get('device-state').textContent==='로그인 전');
  assert.equal(x.nodes.get('device-panel').hidden,true);
});

test('silent logout invalidates an older pending status response',async t=>{
  const pending=deferred();
  const x=setup(t,()=>pending.promise);
  await until(()=>x.calls.includes('status'));
  x.setToken(null);pending.resolve(ok(approved));await tick();await tick();
  assert.equal(x.nodes.get('device-state').textContent,'로그인 전');
  assert.equal(x.nodes.get('device-panel').hidden,true);
});

test('identity change cancels an active browser authenticator prompt',async t=>{
  for(const kind of ['registration','authentication']){
    await t.test(kind,async t=>{
      const pending=deferred();let started=false,cancelled=0;
      const x=setup(t,action=>ok(action==='status'?approved:{}));
      x.win.SimpleWebAuthnBrowser.WebAuthnAbortService={cancelCeremony(){
        cancelled++;pending.reject(Object.assign(Error('canceled'),{name:'AbortError'}));
      }};
      x.win.SimpleWebAuthnBrowser[kind==='registration'?'startRegistration':'startAuthentication']=()=>{
        started=true;return pending.promise;
      };
      await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
      click(x.nodes.get(kind==='registration'?'device-enroll':'device-unlock'));
      await until(()=>started);
      x.setToken(null);x.win.dispatchEvent(new Event('aleph:identity'));
      await tick();await tick();
      assert.equal(cancelled,1,'the SDK must be asked to dismiss its active prompt');
      assert.equal(x.opened.length,0);
      assert.equal(x.nodes.get('device-state').textContent,'로그인 전');
    });
  }
});

test('identity change while awaiting server options does not cancel an unrelated browser ceremony',async t=>{
  const pending=deferred();let cancelled=0;
  const x=setup(t,action=>action==='assertion-options'?pending.promise:ok(approved));
  x.win.SimpleWebAuthnBrowser.WebAuthnAbortService={cancelCeremony(){cancelled++;}};
  await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
  click(x.nodes.get('device-unlock'));await until(()=>x.calls.includes('assertion-options'));
  x.setToken(null);x.win.dispatchEvent(new Event('aleph:identity'));
  pending.resolve(ok({}));await tick();await tick();
  assert.equal(cancelled,0);
  assert.equal(x.opened.length,0);
});

test('a stale prompt completion cannot clear the cancellation handle of a newer prompt',async t=>{
  const old=deferred(),current=deferred();let started=0,cancelled=0;
  const x=setup(t,action=>ok(action==='status'?approved:{}));
  x.win.SimpleWebAuthnBrowser.startAuthentication=()=>++started===1?old.promise:current.promise;
  x.win.SimpleWebAuthnBrowser.WebAuthnAbortService={cancelCeremony(){cancelled++;}};
  await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
  click(x.nodes.get('device-unlock'));await until(()=>started===1);
  x.setToken('synthetic-session-b');x.win.dispatchEvent(new Event('aleph:identity'));
  await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
  click(x.nodes.get('device-unlock'));await until(()=>started===2);
  old.reject(Error('old prompt ended'));await tick();await tick();
  x.setToken(null);x.win.dispatchEvent(new Event('aleph:identity'));
  current.reject(Error('current prompt ended'));await tick();await tick();
  assert.equal(cancelled,2);
  assert.equal(x.opened.length,0);
  assert.equal(x.nodes.get('device-state').textContent,'로그인 전');
});

test('a cancellation service failure does not prevent the identity lock',async t=>{
  const pending=deferred();let started=false;
  const x=setup(t,action=>ok(action==='status'?approved:{}));
  x.win.SimpleWebAuthnBrowser.startAuthentication=()=>{started=true;return pending.promise;};
  x.win.SimpleWebAuthnBrowser.WebAuthnAbortService={cancelCeremony(){throw Error('unavailable');}};
  await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
  click(x.nodes.get('device-unlock'));await until(()=>started);
  x.setToken(null);x.win.dispatchEvent(new Event('aleph:identity'));
  pending.resolve({});await tick();await tick();
  assert.equal(x.opened.length,0);
  assert.equal(x.nodes.get('device-state').textContent,'로그인 전');
  assert.equal(x.nodes.get('device-panel').hidden,true);
});
