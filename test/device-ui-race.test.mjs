import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initDeviceAccess } from '../public/device.mjs';
import { verifyDeviceGrant, DEVICE_PROOF_HEADER } from '../src/device-access.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(predicate){for(let i=0;i<40;i++){if(predicate())return;await tick();}throw Error('timed out waiting for test step');}
const ok=data=>Response.json(data);
const proof={schema:'aleph.device.proof.v1',approved:true,proof:'P'.repeat(43),expiresInSeconds:60};
const statusPayload=registration=>({schema:'aleph.device.status.v1',registration,verified:false,canOpenVault:false,installIsApproval:false});
const approved=statusPayload('approved');
const registrationAck={schema:'aleph.device.registration.v1',registration:'approved',verifiedDeviceProof:false,next:'assertion_required'};

function setup(t,handler,options={}){
  let access;
  const saved={};
  for(const key of ['window','document','navigator','fetch','setTimeout','clearTimeout'])saved[key]=Object.getOwnPropertyDescriptor(globalThis,key);
  t.after(()=>{access?.dispose();for(const [key,value] of Object.entries(saved)){
    if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];
  }});
  const timers=new Set();
  if(options.manualTimers){
    globalThis.setTimeout=(fn,delay)=>{const timer={fn,delay};timers.add(timer);return timer;};
    globalThis.clearTimeout=timer=>timers.delete(timer);
  }
  const nodes=new Map();
  const doc={body:{},hasFocus:()=>true,readyState:'complete'};
  doc.activeElement=doc.body;
  for(const id of ['device-state','device-detail','device-enroll','device-unlock','device-refresh','device-panel','device-heading','workspace-title','pwa-state','pwa-install']){
    const el=new EventTarget();Object.assign(el,{hidden:false,disabled:false,textContent:'',focus(){doc.activeElement=el;}});nodes.set(id,el);
  }
  const win=new EventTarget();
  win.PublicKeyCredential=class {};
  win.SimpleWebAuthnBrowser={startRegistration:async()=>({}),startAuthentication:async()=>({})};
  win.matchMedia=()=>({matches:false});
  Object.defineProperty(globalThis,'window',{configurable:true,value:win});
  doc.getElementById=id=>nodes.get(id);
  Object.defineProperty(globalThis,'document',{configurable:true,value:doc});
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{}});
  const calls=[];
  Object.defineProperty(globalThis,'fetch',{configurable:true,value:async (url,requestOptions)=>{
    const action=new URL(url,'http://fixture.invalid').searchParams.get('action');calls.push(action);
    return handler(action,calls,requestOptions);
  }});
  let token='synthetic-session-a';const opened=[];let locked=0;
  access=initDeviceAccess({getAccessToken:()=>token,onAuthorized:(...args)=>opened.push(args),onLocked:()=>locked++,...options});
  return {nodes,doc,win,calls,opened,access,timers,fireHttpTimeout(){
    const timer=[...timers].find(timer=>timer.delay===(options.requestTimeoutMs??10000));assert.ok(timer);
    timers.delete(timer);timer.fn();
  },get locked(){return locked;},setToken:value=>{token=value;}};
}
const click=node=>node.dispatchEvent(new Event('click'));

const without=(value,key)=>Object.fromEntries(Object.entries(value).filter(([name])=>name!==key));
const malformedStatuses=[
  ['null',null],['array',[]],['empty object',{}],['boolean',true],['number',1],['string','approved'],
  ...Object.keys(approved).map(key=>['missing '+key,without(approved,key)]),
  ['wrong schema',{...approved,schema:'unrelated.v1'}],
  ['unknown registration',{...approved,registration:'revoked'}],
  ['string verified',{...approved,verified:'false'}],
  ['string canOpenVault',{...approved,canOpenVault:'false'}],
  ['installation approval',{...approved,installIsApproval:true}],
  ['verified without access',{...approved,verified:true}],
  ['access without verification',{...approved,canOpenVault:true}],
  ...['pending','not_registered'].map(registration=>['verified '+registration,{...statusPayload(registration),verified:true,canOpenVault:true}]),
];
for(const [name,payload] of malformedStatuses)test(`malformed device status ${name} remains unknown and offers only manual recovery`,async t=>{
  const x=setup(t,()=>ok(payload));
  await until(()=>x.nodes.get('device-state').textContent!=='기기 확인 중');
  assert.equal(x.nodes.get('device-state').textContent,'서버 확인 실패');
  assert.match(x.nodes.get('device-detail').textContent,/서버 승인 다시 확인.*재시도/u);
  assert.equal(x.nodes.get('device-enroll').hidden,true);assert.equal(x.nodes.get('device-unlock').hidden,true);
  assert.equal(x.nodes.get('device-refresh').hidden,false);assert.equal(x.nodes.get('device-refresh').disabled,false);
  assert.equal(x.locked,1);assert.equal(x.opened.length,0);assert.deepEqual(x.calls,['status']);
});

for(const [payload,label,action] of [
  [approved,'등록 기기 · 재인증 필요','device-unlock'],
  [statusPayload('pending'),'승인 대기','device-enroll'],
  [statusPayload('not_registered'),'기기 미승인','device-enroll'],
  [{...approved,verified:true,canOpenVault:true},'기기 확인 완료','device-refresh'],
])test(`valid device status ${label} tolerates extension fields and does not authorize a vault`,async t=>{
  const x=setup(t,()=>ok({...payload,futureMetadata:{revision:2}}));
  await until(()=>x.nodes.get('device-state').textContent!=='기기 확인 중');
  assert.equal(x.nodes.get('device-state').textContent,label);assert.equal(x.nodes.get(action).hidden,false);
  assert.equal(x.nodes.get(action).disabled,false);assert.equal(x.opened.length,0);assert.equal(x.locked,0);
  assert.deepEqual(x.calls,['status']);
});

test('manual status refresh recovers from a malformed response without automatically starting a ceremony',async t=>{
  let reads=0,prompts=0;
  const x=setup(t,()=>ok(++reads===1?{}:approved));
  x.win.SimpleWebAuthnBrowser.startRegistration=x.win.SimpleWebAuthnBrowser.startAuthentication=async()=>{prompts++;return {};};
  await until(()=>x.nodes.get('device-state').textContent!=='기기 확인 중');
  x.nodes.get('device-refresh').focus();click(x.nodes.get('device-refresh'));
  await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
  assert.equal(x.nodes.get('device-unlock').hidden,false);assert.equal(x.nodes.get('device-unlock').disabled,false);
  assert.equal(x.doc.activeElement,x.nodes.get('device-refresh'));assert.equal(x.opened.length,0);assert.equal(prompts,0);
  assert.deepEqual(x.calls,['status','status']);
});

const malformedRegistrations=[
  ['null',null],['array',[]],['empty object',{}],['string','approved'],
  ...Object.keys(registrationAck).map(key=>['missing '+key,without(registrationAck,key)]),
  ['wrong schema',{...registrationAck,schema:'unrelated.v1'}],
  ['unapproved registration',{...registrationAck,registration:'pending'}],
  ['already verified proof',{...registrationAck,verifiedDeviceProof:true}],
  ['string proof flag',{...registrationAck,verifiedDeviceProof:'false'}],
  ['wrong next step',{...registrationAck,next:'complete'}],
];
for(const [name,payload] of malformedRegistrations)test(`malformed registration acknowledgement ${name} cannot start a subsequent ceremony`,async t=>{
  let statuses=0,registrations=0,assertions=0;
  const x=setup(t,action=>ok(action==='status'?(++statuses===1?statusPayload('not_registered'):approved)
    :action==='registration-verify'?payload:action==='assertion-verify'?proof:{}));
  x.win.SimpleWebAuthnBrowser.startRegistration=async()=>{registrations++;return {};};
  x.win.SimpleWebAuthnBrowser.startAuthentication=async()=>{assertions++;return {};};
  await until(()=>x.nodes.get('device-state').textContent==='기기 미승인');click(x.nodes.get('device-enroll'));
  await until(()=>statuses===2&&x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
  assert.deepEqual(x.calls,['status','registration-options','registration-verify','status']);
  assert.equal(registrations,1);assert.equal(assertions,0);assert.equal(x.opened.length,0);assert.equal(x.locked,1);
  assert.match(x.nodes.get('device-detail').textContent,/실패/u);assert.equal(x.nodes.get('device-unlock').disabled,false);
});

for(const recovery of ['approved','unknown','newer focus'])test(`invalid registration preserves its notice and ${recovery} recovery focus until an explicit retry`,async t=>{
  const pending=deferred();let statuses=0,assertions=0;
  const x=setup(t,action=>action==='status'?(++statuses===1?ok(statusPayload('not_registered')):pending.promise)
    :ok(action==='registration-verify'?{registration:'approved'}:action==='assertion-verify'?proof:{}));
  x.win.SimpleWebAuthnBrowser.startAuthentication=async()=>{assertions++;return {};};
  await until(()=>x.nodes.get('device-state').textContent==='기기 미승인');
  x.nodes.get('device-enroll').focus();click(x.nodes.get('device-enroll'));await until(()=>statuses===2);
  assert.equal(x.doc.activeElement,x.nodes.get('device-heading'));
  assert.match(x.nodes.get('device-detail').textContent,/실패/u);
  if(recovery==='newer focus')x.nodes.get('device-refresh').focus();
  pending.resolve(ok(recovery==='unknown'?{}:approved));
  await until(()=>x.nodes.get('device-state').textContent!=='기기 확인 중');
  assert.match(x.nodes.get('device-detail').textContent,/실패/u);
  assert.equal(x.doc.activeElement,x.nodes.get(recovery==='newer focus'||recovery==='unknown'?'device-refresh':'device-unlock'));
  assert.equal(assertions,0);assert.equal(x.opened.length,0);assert.equal(x.calls.includes('assertion-options'),false);
  if(recovery==='unknown'){
    assert.equal(x.nodes.get('device-state').textContent,'서버 확인 실패');
    assert.equal(x.nodes.get('device-enroll').hidden,true);assert.equal(x.nodes.get('device-unlock').hidden,true);
    assert.equal(x.nodes.get('device-refresh').disabled,false);
  }else{
    click(x.nodes.get('device-unlock'));await until(()=>x.opened.length===1);
    assert.equal(assertions,1);assert.equal(x.nodes.get('device-state').textContent,'인증기 확인 완료');
  }
});

const malformedProofs=[
  ['null',null],['array',[]],['empty object',{}],
  ...Object.keys(proof).map(key=>['missing '+key,without(proof,key)]),
  ['wrong schema',{...proof,schema:'unrelated.v1'}],['unapproved',{...proof,approved:false}],
  ['truthy approval',{...proof,approved:1}],['number proof',{...proof,proof:123}],
  ['string expiry',{...proof,expiresInSeconds:'60'}],['zero expiry',{...proof,expiresInSeconds:0}],
  ['negative expiry',{...proof,expiresInSeconds:-1}],['null expiry',{...proof,expiresInSeconds:null}],
];
const malformedGrantStrings=[
  ['empty',''],['whitespace',' '],['short','P'.repeat(39)],['long','P'.repeat(101)],
  ['plus','+'.repeat(43)],['padding','P'.repeat(42)+'='],['trailing newline','P'.repeat(43)+'\n'],
];
for(const [name,payload] of [...malformedProofs,...malformedGrantStrings.map(([name,value])=>[name+' grant',{...proof,proof:value}])])
test(`malformed device proof ${name} stays locked and permits manual retry`,async t=>{
  const x=setup(t,action=>ok(action==='status'?approved:action==='assertion-verify'?payload:{}));
  await until(()=>!x.nodes.get('device-unlock').hidden);click(x.nodes.get('device-unlock'));
  await until(()=>x.calls.filter(action=>action==='status').length===2&&x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
  assert.equal(x.opened.length,0);assert.equal(x.locked,1);assert.match(x.nodes.get('device-detail').textContent,/실패/u);
  assert.equal(x.nodes.get('device-unlock').hidden,false);assert.equal(x.nodes.get('device-unlock').disabled,false);
  assert.equal(x.calls.filter(action=>action==='assertion-options').length,1);
});

test('the UI negative grant syntax cases are also rejected by the actual server before any database lookup',async()=>{
  for(const [name,value] of malformedGrantStrings){
    let lookups=0;
    const verified=await verifyDeviceGrant({db:{from(){lookups++;throw Error('synthetic absent database');}},
      identity:{kind:'student',userId:'fixture'},authorization:'Bearer synthetic',headers:{[DEVICE_PROOF_HEADER]:value}});
    assert.equal(verified,false,name);assert.equal(lookups,0,name);
  }
});

test('a valid JSON number that overflows to an infinite proof lifetime cannot authorize',async t=>{
  const raw=JSON.stringify(proof).replace('"expiresInSeconds":60','"expiresInSeconds":1e400');
  assert.equal(JSON.parse(raw).expiresInSeconds,Infinity);
  const x=setup(t,action=>action==='assertion-verify'?new Response(raw,{headers:{'content-type':'application/json'}})
    :ok(action==='status'?approved:{}));
  await until(()=>!x.nodes.get('device-unlock').hidden);click(x.nodes.get('device-unlock'));
  await until(()=>x.calls.filter(action=>action==='status').length===2&&x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
  assert.equal(x.opened.length,0);assert.equal(x.locked,1);assert.equal(x.nodes.get('device-unlock').disabled,false);
});

for(const length of [40,42,43,100])test(`server-accepted proof length ${length} and registration extensions preserve the explicit ceremony`,async t=>{
  const value='_-'+ 'P'.repeat(length-2),expiry=length===42?60.5:3600;let lookups=0,assertions=0;
  assert.equal(await verifyDeviceGrant({db:{from(){lookups++;throw Error('synthetic absent database');}},
    identity:{kind:'student',userId:'fixture'},authorization:'Bearer synthetic',headers:{[DEVICE_PROOF_HEADER]:value}}),false);
  assert.equal(lookups,1,'the real server accepts syntax; this is not a database-backed grant');
  const x=setup(t,action=>ok(action==='status'?statusPayload('not_registered')
    :action==='registration-verify'?{...registrationAck,futureMetadata:{revision:2}}
    :action==='assertion-verify'?{...proof,proof:value,expiresInSeconds:expiry,futureMetadata:{revision:2}}:{}));
  x.win.SimpleWebAuthnBrowser.startAuthentication=async()=>{assertions++;return {};};
  await until(()=>x.nodes.get('device-state').textContent==='기기 미승인');click(x.nodes.get('device-enroll'));
  await until(()=>x.opened.length===1);
  assert.deepEqual(x.opened,[[value,expiry]],'accepted proof and lifetime are forwarded without rewriting');
  assert.equal(assertions,1);assert.equal(x.nodes.get('device-state').textContent,'인증기 확인 완료');
  assert.deepEqual(x.calls,['status','registration-options','registration-verify','assertion-options','assertion-verify']);
});

for(const step of ['status','registration-verify','assertion-verify'])
test(`late malformed ${step} cannot change a newly verified session or its focus`,async t=>{
  const pending=deferred();let held=false,replaced=false;
  const x=setup(t,action=>{
    if(action===step&&!held){held=true;return pending.promise;}
    return ok(action==='status'?(step==='registration-verify'&&!replaced?statusPayload('not_registered'):approved)
      :action==='registration-verify'?registrationAck:action==='assertion-verify'?proof:{});
  });
  if(step!=='status'){
    await until(()=>x.nodes.get('device-state').textContent!=='기기 확인 중');
    const button=x.nodes.get(step==='registration-verify'?'device-enroll':'device-unlock');button.focus();click(button);
  }
  await until(()=>held);replaced=true;x.setToken('synthetic-session-b');x.win.dispatchEvent(new Event('aleph:identity'));
  await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
  click(x.nodes.get('device-unlock'));await until(()=>x.opened.length===1);
  x.nodes.get('device-refresh').focus();const locks=x.locked,requests=x.calls.length;
  pending.resolve(ok({}));await tick();await tick();
  assert.equal(x.opened.length,1);assert.equal(x.locked,locks);assert.equal(x.calls.length,requests);
  assert.equal(x.nodes.get('device-state').textContent,'인증기 확인 완료');
  assert.equal(x.doc.activeElement,x.nodes.get('device-refresh'));
});

test('a successful device response releases its acquired reader lock',async t=>{
  const received=ok(approved),x=setup(t,()=>received);
  await until(()=>x.nodes.get('device-state').textContent==='등록 기기 · 재인증 필요');
  assert.equal(received.body.locked,false);
});

test('device deadline releases a pending reader even when cancellation never settles',async t=>{
  let cancelled=0;
  const received=new Response(new ReadableStream({cancel(){cancelled++;return new Promise(()=>{});}}),{headers:{'content-type':'application/json'}});
  const x=setup(t,action=>action==='assertion-verify'?received:ok(action==='status'?approved:{}),{manualTimers:true});
  await until(()=>!x.nodes.get('device-unlock').hidden);click(x.nodes.get('device-unlock'));
  await until(()=>received.body.locked);x.fireHttpTimeout();
  await until(()=>!x.nodes.get('device-unlock').disabled);
  assert.equal(cancelled,1);assert.equal(received.body.locked,false);assert.equal(x.opened.length,0);
});

test('device actions wait for server status before offering registration or authentication',async t=>{
  const pending=deferred();
  const x=setup(t,()=>pending.promise);
  await until(()=>x.calls.includes('status'));
  assert.equal(x.nodes.get('device-enroll').hidden,true);
  assert.equal(x.nodes.get('device-unlock').hidden,true);
  assert.equal(x.nodes.get('device-refresh').hidden,false);
  pending.resolve(ok(approved));
  await until(()=>!x.nodes.get('device-unlock').hidden);
  assert.equal(x.nodes.get('device-enroll').hidden,true);
});

test('canceled authentication preserves its reason during rediscovery and restores keyboard retry focus',async t=>{
  const pending=deferred();let statuses=0;
  const x=setup(t,action=>action==='status'&&++statuses===2?pending.promise:ok(action==='status'?approved:{}));
  x.win.SimpleWebAuthnBrowser.startAuthentication=async()=>{throw Object.assign(Error('canceled'),{name:'NotAllowedError'});};
  await until(()=>!x.nodes.get('device-unlock').hidden);
  x.nodes.get('device-unlock').focus();click(x.nodes.get('device-unlock'));
  await until(()=>statuses===2);
  assert.equal(x.doc.activeElement,x.nodes.get('device-heading'));
  assert.match(x.nodes.get('device-detail').textContent,/인증이 취소되었습니다/u);
  assert.equal(x.opened.length,0);
  pending.resolve(ok(approved));
  await until(()=>x.doc.activeElement===x.nodes.get('device-unlock'));
  assert.match(x.nodes.get('device-detail').textContent,/인증이 취소되었습니다/u);
  assert.equal(x.nodes.get('device-enroll').hidden,true);
});

test('successful keyboard authentication focuses the opened editor without taking focus from other controls',async t=>{
  const pending=deferred();let assertions=0;
  const x=setup(t,action=>action==='assertion-verify'&&++assertions===2?pending.promise:ok(action==='status'?approved:action==='assertion-verify'?proof:{}));
  await until(()=>!x.nodes.get('device-unlock').hidden);
  x.nodes.get('device-unlock').focus();click(x.nodes.get('device-unlock'));
  await until(()=>x.opened.length===1);
  assert.equal(x.doc.activeElement,x.nodes.get('workspace-title'));
  x.win.dispatchEvent(new Event('aleph:identity'));
  await until(()=>!x.nodes.get('device-unlock').hidden);
  x.nodes.get('device-unlock').focus();click(x.nodes.get('device-unlock'));
  await until(()=>assertions===2);
  x.nodes.get('device-refresh').focus();pending.resolve(ok(proof));
  await until(()=>x.opened.length===2);
  assert.equal(x.doc.activeElement,x.nodes.get('device-refresh'));
});

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
        return ok(action==='status'?approved:action==='registration-verify'?registrationAck:action==='assertion-verify'?proof:{});
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
      pending.resolve(step.endsWith('prompt')?{}:ok(step==='registration-verify'?registrationAck:step==='assertion-verify'?proof:{}));
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
    return ++count===1?first.promise:ok(statusPayload('pending'));
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
    if(action==='assertion-verify'&&fail)return Response.json({error:'DENIED'},{status:403});
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

const openJsonStream=onCancel=>new Response(new ReadableStream({cancel:onCancel}),{headers:{'content-type':'application/json'}});

test('device options timeout restores retry and discards a late HTTP response without opening an authenticator',async t=>{
  const late=deferred();let optionsSignal,prompts=0,cancelled=0;
  const x=setup(t,(action,_calls,options)=>{
    if(action==='assertion-options'){optionsSignal=options.signal;return late.promise;}
    return ok(approved);
  },{manualTimers:true});
  x.win.SimpleWebAuthnBrowser.startAuthentication=async()=>{prompts++;return {};};
  await until(()=>!x.nodes.get('device-unlock').hidden);
  click(x.nodes.get('device-unlock'));
  await until(()=>optionsSignal);
  assert.equal(optionsSignal.aborted,false);
  x.fireHttpTimeout();await until(()=>x.nodes.get('device-unlock').disabled===false);
  await until(()=>/확인 시간이 초과/u.test(x.nodes.get('device-detail').textContent));
  assert.equal(optionsSignal.aborted,true);
  assert.equal(x.nodes.get('device-unlock').disabled,false);
  assert.match(x.nodes.get('device-detail').textContent,/확인 시간이 초과/u);
  assert.equal(x.opened.length,0);
  late.resolve(openJsonStream(()=>{cancelled++;}));
  await tick();await tick();
  assert.equal(cancelled,1);
  assert.equal(prompts,0);
});

test('device verification stalled body is cancelled at the HTTP deadline and remains locked',async t=>{
  let cancelled=0,verification=false;
  const x=setup(t,action=>{
    if(action==='assertion-verify'){verification=true;return openJsonStream(()=>{cancelled++;});}
    return ok(action==='status'?approved:{});
  },{manualTimers:true});
  await until(()=>!x.nodes.get('device-unlock').hidden);
  click(x.nodes.get('device-unlock'));await until(()=>verification);
  x.fireHttpTimeout();await until(()=>x.nodes.get('device-unlock').disabled===false);
  assert.equal(cancelled,1);
  assert.equal(x.opened.length,0);
  assert.equal(x.nodes.get('device-refresh').disabled,false);
  assert.match(x.nodes.get('device-detail').textContent,/시간이 초과/u);
});

test('the HTTP deadline does not time out the separate interactive authenticator prompt',async t=>{
  const prompt=deferred();let prompted=false;
  const x=setup(t,action=>ok(action==='status'?approved:action==='assertion-verify'?proof:{}),{manualTimers:true});
  x.win.SimpleWebAuthnBrowser.startAuthentication=()=>{prompted=true;return prompt.promise;};
  await until(()=>!x.nodes.get('device-unlock').hidden);
  click(x.nodes.get('device-unlock'));await until(()=>prompted);
  assert.equal(x.timers.size,0,'network deadline ends before the interactive prompt starts');
  await tick();
  assert.equal(x.nodes.get('device-unlock').disabled,true);
  assert.equal(x.opened.length,0);
  prompt.resolve({});await until(()=>x.opened.length===1);
  assert.equal(x.nodes.get('device-state').textContent,'인증기 확인 완료');
});

test('identity replacement and disposal abort owned HTTP requests without late state changes',async t=>{
  const late=deferred();let pendingSignal,cancelled=0;
  const x=setup(t,(action,_calls,options)=>{
    if(action==='assertion-options'){pendingSignal=options.signal;return late.promise;}
    return ok(approved);
  });
  await until(()=>!x.nodes.get('device-unlock').hidden);
  click(x.nodes.get('device-unlock'));await until(()=>pendingSignal);
  x.setToken(null);x.win.dispatchEvent(new Event('aleph:identity'));
  assert.equal(pendingSignal.aborted,true);
  assert.equal(x.nodes.get('device-state').textContent,'로그인 전');
  late.resolve(openJsonStream(()=>{cancelled++;}));await tick();await tick();
  assert.equal(cancelled,1);
  const count=x.calls.length;
  x.access.dispose();x.access.dispose();
  x.setToken('synthetic-session-c');x.win.dispatchEvent(new Event('aleph:identity'));
  await x.access.status();await tick();
  assert.equal(x.calls.length,count);
  assert.equal(x.opened.length,0);
});

test('device HTTP rejects oversized and non-JSON responses without accepting a proof',async t=>{
  for(const kind of ['declared-size','stream-size','mime'])await t.test(kind,async t=>{
    let cancelled=0;
    const x=setup(t,action=>{
      if(action!=='assertion-verify')return ok(action==='status'?approved:{});
      const headers={'content-type':kind==='mime'?'text/html':'application/json'};
      if(kind==='declared-size')headers['content-length']='65537';
      const body=new ReadableStream({
        start(controller){if(kind==='stream-size')controller.enqueue(new Uint8Array(65537));},
        cancel(){cancelled++;},
      });
      return new Response(body,{headers});
    });
    await until(()=>!x.nodes.get('device-unlock').hidden);
    click(x.nodes.get('device-unlock'));
    await until(()=>cancelled===1&&!x.nodes.get('device-unlock').disabled);
    assert.equal(x.opened.length,0);
    assert.match(x.nodes.get('device-detail').textContent,/보호 자료는 표시하지 않습니다/u);
  });
});

function installationEvent(prompt,userChoice){
  const event=new Event('beforeinstallprompt',{cancelable:true});
  event.prompt=prompt;event.userChoice=userChoice;return event;
}

test('installation labels describe display state before verification, after verification and after locking',async t=>{
  const x=setup(t,action=>ok(action==='status'?approved:action==='assertion-verify'?proof:{}));
  await until(()=>!x.nodes.get('device-unlock').hidden);
  for(const phase of ['before verification','after verification','after locking']){
    if(phase==='after verification'){
      click(x.nodes.get('device-unlock'));await until(()=>x.opened.length===1);
      assert.equal(x.nodes.get('device-state').textContent,'인증기 확인 완료');
    }else if(phase==='after locking')x.access.lock();
    const authorizations=x.opened.length;
    x.win.matchMedia=()=>({matches:false});
    x.win.dispatchEvent(installationEvent(async()=>{},Promise.resolve({outcome:'dismissed'})));
    assert.match(x.nodes.get('pwa-state').textContent,/설치 가능.*기기 승인은 별도/u,phase);
    assert.doesNotMatch(x.nodes.get('pwa-state').textContent,/미검증|승인 필요|검증 완료/u,phase);
    x.win.matchMedia=()=>({matches:true});x.win.dispatchEvent(new Event('appinstalled'));
    assert.match(x.nodes.get('pwa-state').textContent,/앱 설치형 실행 중.*기기 승인은 별도/u,phase);
    assert.doesNotMatch(x.nodes.get('pwa-state').textContent,/미검증|승인 필요|검증 완료/u,phase);
    assert.equal(x.opened.length,authorizations,'installation must never grant device access');
  }
});

test('rejected and dismissed PWA prompts have distinct safe outcomes and consume the prompt once',async t=>{
  const x=setup(t,()=>ok(approved));
  let called=0;
  x.win.dispatchEvent(installationEvent(async()=>{called++;throw Error('private prompt failure');}));
  click(x.nodes.get('pwa-install'));await tick();await tick();
  assert.match(x.nodes.get('pwa-state').textContent,/설치 화면을 열지 못했습니다/u);
  assert.match(x.nodes.get('pwa-state').textContent,/브라우저 메뉴/u);
  assert.doesNotMatch(x.nodes.get('pwa-state').textContent,/private/u);
  assert.equal(x.nodes.get('pwa-install').hidden,true);
  click(x.nodes.get('pwa-install'));await tick();assert.equal(called,1);
  x.win.dispatchEvent(installationEvent(async()=>{called++;},Promise.resolve({outcome:'dismissed'})));
  assert.equal(x.nodes.get('pwa-install').hidden,false);
  click(x.nodes.get('pwa-install'));await tick();await tick();
  assert.match(x.nodes.get('pwa-state').textContent,/설치를 취소했습니다/u);
  assert.equal(x.opened.length,0);
  assert.equal(called,2);
});

test('a late PWA prompt failure cannot overwrite a newer installation event',async t=>{
  const pending=deferred();
  const x=setup(t,()=>ok(approved));
  x.win.dispatchEvent(installationEvent(()=>pending.promise));
  click(x.nodes.get('pwa-install'));
  x.win.dispatchEvent(new Event('appinstalled'));
  pending.reject(Error('late failure'));await tick();await tick();
  assert.match(x.nodes.get('pwa-state').textContent,/설치 완료 이벤트/u);
  assert.equal(x.opened.length,0);
});

test('a rejected install choice is handled even while the prompt promise is still pending',async t=>{
  const prompt=deferred(),choice=deferred();
  const x=setup(t,()=>ok(approved));
  x.win.dispatchEvent(installationEvent(()=>prompt.promise,choice.promise));click(x.nodes.get('pwa-install'));
  choice.reject(Error('private install choice failure'));await tick();await tick();
  assert.match(x.nodes.get('pwa-state').textContent,/설치 화면을 열지 못했습니다/u);
  assert.doesNotMatch(x.nodes.get('pwa-state').textContent,/private/u);
  prompt.resolve();await tick();assert.equal(x.nodes.get('pwa-install').hidden,true);
});
