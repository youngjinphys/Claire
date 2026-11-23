import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createAiConnectController,createNativeLoginController,nativeLoginView} from '../public/ai-connect.mjs';

const id='11111111-1111-4111-8111-111111111111';
const challenge='A'.repeat(43);
const origin='https://aleph-omega.vercel.app/workbench.html';
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};

function fixture(t,type){
  let wall=100000,mono=0,nextTimer=0;
  const hooks={},states=[],requests=[],active=new Set(),clears=new Map(),pending=[],actions=[];
  const consume=(name,...args)=>{const fn=hooks[name];delete hooks[name];return fn?.(...args);};
  const empty=state=>({state,expiresAtMs:null,approvalUrl:null,confirmation:null});
  const data=kind=>type==='native'
    ?kind==='cancel'?empty('cancelled'):kind==='current'||kind==='redeem'?{state:'connected',expiresAtMs:110000,approvalUrl:null,confirmation:null}
      :{state:'awaiting_approval',expiresAtMs:110000,approvalUrl:`${origin}?nativeLogin=alekov&device=${id}&challenge=${challenge}`,confirmation:'123456'}
    :kind==='start'?{state:'awaiting_approval',connectionId:id,expiresAt:new Date(110000).toISOString(),approvalUrl:`${origin}?appConnect=alekov&appDevice=${id}&appChallenge=${challenge}`,confirmation:'abcd-1234'}
      :{connectionId:id,state:kind==='finish'?'checking':kind==='cancel'?'cancelled':'connected',expiresAt:new Date(110000).toISOString(),reason:null};
  const f={type,hooks,states,requests,active,clears,pendingMode:false,ui:null,
    advance(ms){wall+=ms;mono+=ms;},
    track(promise){actions.push(promise);return promise;},
    fire(timer){active.delete(timer);timer.fn();},
    async prepare(){if(type==='native'){if(f.ui.state.phase==='idle')await f.ui.start();else await f.ui.check();}
      else{await f.ui.start();await f.ui.finish();}assert.equal(active.size,1);return [...active][0];},
  };
  const transport=(kind,body,options)=>{
    const signal=(type==='native'?body:options).signal;
    const request={kind,signal};requests.push(request);
    signal.addEventListener('abort',()=>consume('abort',request),{once:true});
    const response=consume('transport',request);
    if(response!==undefined)return response;
    if(f.pendingMode){const gate=deferred();pending.push(gate);return gate.promise;}
    return Promise.resolve({ok:true,data:data(kind)});
  };
  const options={transport,
    clock:()=>consume('clock')??wall,monotonic:()=>consume('monotonic')??mono,
    onChange:state=>{states.push(state);consume('change',state);},onInvalidate:reason=>consume('invalidate',reason),
    setTimer:(fn,ms)=>{const timer={id:++nextTimer,fn,ms};active.add(timer);clears.set(timer,0);consume('timer',timer);return timer;},
    clearTimer:timer=>{clears.set(timer,(clears.get(timer)??0)+1);active.delete(timer);consume('clear',timer);},
  };
  f.ui=(type==='native'?createNativeLoginController:createAiConnectController)(options);
  t.after(async()=>{for(const key of Object.keys(hooks))delete hooks[key];f.ui.reset();
    for(const gate of pending)gate.resolve({ok:false,error:{code:type==='native'?'NATIVE_LOGIN_CANCELLED':'ALEKOV_CONNECT_CANCELLED'}});
    await Promise.allSettled(actions);
  });
  return f;
}

test('generic normal checking polls once and releases its timer',async t=>{
  const f=fixture(t,'generic'),timer=await f.prepare();
  assert.equal(f.ui.state.phase,'checking');f.fire(timer);await turn();
  assert.equal(f.ui.state.phase,'connected');assert.deepEqual(f.requests.map(x=>x.kind),['start','finish','status']);
  assert.equal(f.active.size,0);f.ui.reset();assert.equal(f.ui.state.phase,'idle');
});

test('native normal expiry changes only local state and explicit cancel still confirms',async t=>{
  const f=fixture(t,'native'),timer=await f.prepare();
  assert.equal(f.ui.state.phase,'awaiting_approval');f.advance(10000);f.fire(timer);
  assert.equal(f.ui.state.phase,'expired');assert.equal(f.active.size,0);assert.equal(f.requests.length,1);
  await f.ui.cancel();assert.equal(f.ui.state.phase,'cancelled');assert.equal(f.ui.state.cancelUnconfirmed,false);
});

test('generic onChange reset prevents the superseded start request',async t=>{
  const f=fixture(t,'generic');f.hooks.change=state=>{assert.equal(state.phase,'starting');f.ui.reset();};
  await f.ui.start();assert.equal(f.ui.state.phase,'idle');assert.equal(f.requests.length,0);
});

test('generic poll clock reset cannot publish the older timeout',async t=>{
  const f=fixture(t,'generic');await f.ui.start();
  f.hooks.clock=()=>{f.ui.reset();return 200000;};
  await f.ui.finish();assert.equal(f.ui.state.phase,'idle');assert.equal(f.active.size,0);
});

for(const type of ['generic','native']){
  test(`${type} abort callback cannot detach a replacement request`,async t=>{
    const f=fixture(t,type);f.pendingMode=true;f.track(f.ui.start());
    assert.equal(f.requests.length,1);
    f.hooks.abort=()=>{f.ui.reset();f.track(type==='native'?f.ui.check():f.ui.start());};
    f.ui.reset();assert.equal(f.requests.length,2);
    const next=f.requests[1].signal;assert.equal(next.aborted,false);
    assert.equal(f.ui.state.phase,type==='native'?'checking':'starting');
    f.ui.reset();assert.equal(next.aborted,true,'the replacement controller remains owned');
  });
  test(`${type} timer returned after factory reset is retired`,async t=>{
    const f=fixture(t,type);if(type==='generic')await f.ui.start();
    let returned;f.hooks.timer=timer=>{returned=timer;f.ui.reset();};
    await(type==='native'?f.ui.start():f.ui.finish());
    assert.equal(f.ui.state.phase,type==='native'?'unknown':'idle');
    assert.equal(f.active.size,0,'the returned obsolete handle is cleared before fallback cleanup');
    assert.equal(f.clears.get(returned),1);
  });
  test(`${type} obsolete timer callback cannot hide a newer timer`,async t=>{
    const f=fixture(t,type),old=await f.prepare();f.ui.reset();
    const next=await f.prepare();assert.notEqual(old,next);old.fn();
    assert.ok(f.active.has(next));f.ui.reset();
    assert.equal(f.clears.get(next),1,'the exact newer timer remains reachable for cleanup');
    assert.equal(f.active.size,0);
  });
  test(`${type} clearTimer reset prevents a stale continuation`,async t=>{
    const f=fixture(t,type);await f.prepare();const count=f.requests.length;
    f.hooks.clear=()=>f.ui.reset();
    await(type==='native'?f.ui.check():f.ui.refresh());
    assert.equal(f.requests.length,count,'no request after cleanup invalidates its generation');
    assert.equal(f.ui.state.phase,type==='native'?'unknown':'idle');assert.equal(f.active.size,0);
  });
}

test('native invalidation callback reset prevents the superseded start',async t=>{
  const f=fixture(t,'native');f.hooks.invalidate=reason=>{assert.equal(reason,'start');f.ui.reset();};
  await f.ui.start();assert.equal(f.ui.state.phase,'idle');assert.equal(f.requests.length,0);
});

test('native completion abort returns the state established by its callback',async t=>{
  const f=fixture(t,'native');
  f.hooks.transport=()=>Promise.resolve({ok:true,data:{state:'disconnected',expiresAtMs:null,approvalUrl:null,confirmation:null}});
  f.hooks.abort=()=>f.ui.reset();
  const returned=await f.ui.check();assert.equal(f.ui.state.phase,'idle');assert.equal(returned,f.ui.state);
});

// Entry and final-acceptance regressions first established in the frozen A17 review.
const data={state:'disconnected',expiresAtMs:null,approvalUrl:null,confirmation:null};
for(const stage of ['none','initial','validation'])test(`native UI reset during ${stage} clock preserves the newer generation`,async t=>{
  let ui,started=false,afterTransport=false,reads=0,resets=0,fetches=0;
  const phases=[];
  ui=createNativeLoginController({clock:()=>{
    if(started&&resets===0&&(stage==='initial'||stage==='validation'&&afterTransport&&++reads===2)){
      resets++;ui.reset();
    }
    return 100000;
  },monotonic:()=>0,onChange:state=>phases.push(state.phase),transport:async()=>{fetches++;afterTransport=true;return {ok:true,data};},setTimer:()=>{throw Error('No expiry timer expected');},clearTimer:()=>{}});
  t.after(()=>ui.reset());started=true;
  await ui.check();
  console.log(JSON.stringify({stage,resets,fetches,phase:ui.state.phase,reason:ui.state.reason,phases}));
  if(stage==='none'){assert.equal(ui.state.phase,'disconnected');assert.equal(fetches,1);}
  else{
    assert.equal(resets,1);
    assert.equal(ui.state.phase,stage==='initial'?'idle':'unknown','older work must not overwrite reset state');
    if(stage==='validation')assert.equal(ui.state.reason,'NATIVE_LOGIN_LOCAL_RESET');
    assert.equal(fetches,stage==='initial'?0:1);
  }
});

const proofData=state=>({ok:true,data:{state,expiresAtMs:state==='connected'?160000:null,approvalUrl:null,confirmation:null}});
function proofFixture(t,clock){
  const calls=[],timers=new Set();let controller;
  let reply=kind=>proofData(kind==='cancel'?'cancelled':'connected');
  controller=createNativeLoginController({clock:()=>clock(controller),monotonic:()=>0,
    transport:async kind=>{calls.push(kind);return reply(kind);},
    setTimer:(fn,ms)=>{const token={fn,ms};timers.add(token);return token;},clearTimer:token=>timers.delete(token)});
  t.after(()=>controller.reset());
  return {controller,calls,timers,use:value=>{reply=value;}};
}

test('reset during initial deadline clock must not leave a stale busy UI',async t=>{
  let armed=true,resets=0;
  const f=proofFixture(t,controller=>{if(armed){armed=false;resets++;controller.reset();}return 100000;});
  await f.controller.start();
  assert.equal(resets,1);assert.equal(f.calls.length,0);
  assert.equal(f.controller.state.phase,'idle','explicit reset must own the state after the old begin is invalidated');
  const view=nativeLoginView(f.controller.state,100000);
  assert.equal(view.busy,false);assert.equal(view.canStart,true);assert.equal(f.timers.size,0);
});

test('reset during final cancellation validation must not publish a stale confirmed cancellation',async t=>{
  let delivered=false,afterResponseClocks=0,resets=0,stateAtReset;
  const f=proofFixture(t,controller=>{
    if(delivered&&++afterResponseClocks===2){delivered=false;resets++;controller.reset();stateAtReset=controller.state;}
    return 100000;
  });
  await f.controller.check();assert.equal(f.controller.state.phase,'connected');
  f.use(kind=>{assert.equal(kind,'cancel');delivered=true;return proofData('cancelled');});
  await f.controller.cancel();
  assert.equal(resets,1);assert.equal(stateAtReset.phase,'unknown');assert.equal(stateAtReset.cancelUnconfirmed,true);
  assert.equal(f.controller.state.phase,'unknown','final clock callback reset must prevent old acknowledgment publication');
  assert.equal(f.controller.state.cancelUnconfirmed,true);
  assert.equal(nativeLoginView(f.controller.state,100000).canCancel,true);
  assert.equal(f.calls.filter(kind=>kind==='cancel').length,1);
  f.use(()=>proofData('cancelled'));await f.controller.cancel();
  assert.equal(f.controller.state.phase,'cancelled');assert.equal(f.controller.state.cancelUnconfirmed,false);
});

test('ordinary current proof and explicit cancellation remain a valid positive control',async t=>{
  const f=proofFixture(t,()=>100000);
  await f.controller.check();assert.equal(f.controller.state.phase,'connected');
  assert.deepEqual(f.calls,['status','current']);
  await f.controller.cancel();assert.equal(f.controller.state.phase,'cancelled');
  assert.equal(f.controller.state.cancelUnconfirmed,false);assert.equal(f.timers.size,0);
  assert.deepEqual(f.calls,['status','current','cancel']);
});

for(const [boundary,label] of [[2,'final response validation'],[4,'accepted expiry projection']])
test('reset during '+label+' cannot publish a stale connected state',async t=>{
  let currentDelivered=false,clocksAfterCurrent=0,resets=0,controller,stateAtReset;
  const timers=new Set(),calls=[];
  controller=createNativeLoginController({
    clock:()=>{
      if(currentDelivered&&++clocksAfterCurrent===boundary){
        currentDelivered=false;resets++;controller.reset();stateAtReset=controller.state;
      }
      return 100000;
    },monotonic:()=>0,
    transport:async kind=>{
      calls.push(kind);assert.ok(['status','current'].includes(kind));
      if(kind==='current')currentDelivered=true;
      return {ok:true,data:{state:'connected',expiresAtMs:160000,approvalUrl:null,confirmation:null}};
    },
    setTimer:(fn,ms)=>{const timer={fn,ms};timers.add(timer);return timer;},clearTimer:timer=>timers.delete(timer),
  });
  t.after(()=>controller.reset());
  await controller.check();
  assert.deepEqual(calls,['status','current']);assert.equal(resets,1);assert.equal(stateAtReset.phase,'unknown');
  assert.equal(controller.state.phase,'unknown','the reset generation must own the final visible state');
  assert.notEqual(nativeLoginView(controller.state,100000).phase,'connected');
  assert.equal(timers.size,0,'reset must not arm a stale success expiry');
});

test('native initial monotonic reset stops later callbacks and entry publication',async t=>{
  const f=fixture(t,'native');let clocks=0;
  f.hooks.monotonic=()=>{f.ui.reset();return 0;};
  f.hooks.clock=()=>{clocks++;return 100000;};
  await f.ui.check();assert.equal(clocks,0);assert.equal(f.requests.length,0);assert.equal(f.ui.state.phase,'idle');
});

test('native deadline clock reset is checked before transport dispatch',async t=>{
  const f=fixture(t,'native');
  f.hooks.change=()=>{f.hooks.clock=()=>{f.ui.reset();return 100000;};};
  await f.ui.check();assert.equal(f.requests.length,0);assert.equal(f.ui.state.phase,'unknown');
  assert.equal(f.ui.state.reason,'NATIVE_LOGIN_LOCAL_RESET');
});

test('generic cancellation uncertainty survives unknown until a manual confirmed observation',async t=>{
  const f=fixture(t,'generic');await f.prepare();
  f.hooks.transport=()=>Promise.resolve({ok:false,error:{code:'ALEKOV_CONNECT_NETWORK'}});
  await f.ui.cancel();assert.equal(f.ui.state.phase,'unknown');assert.equal(f.ui.state.cancelUnconfirmed,true);
  assert.equal(f.active.size,0);
  f.hooks.transport=()=>Promise.resolve({ok:true,data:{connectionId:id,state:'unknown',expiresAt:null,reason:null}});
  await f.ui.refresh();assert.equal(f.ui.state.phase,'unknown');assert.equal(f.ui.state.cancelUnconfirmed,true);
  assert.equal(f.active.size,0);
  await f.ui.refresh();assert.equal(f.ui.state.phase,'connected');assert.equal(f.ui.state.cancelUnconfirmed,false);
  assert.deepEqual(f.requests.map(x=>x.kind),['start','finish','cancel','status','status']);
});

// Final sampling must not publish already-expired proof, or add unneeded callbacks.

for(const elapsed of [9,10,11])test(`final acceptance spends ${elapsed}ms of a 10ms proof without publishing expired success`,async t=>{
  let wall=100000,mono=0,afterCurrent=false,reads=0,consumed=0;
  const calls=[],phases=[],invalidations=[],timers=new Set();
  const ui=createNativeLoginController({actionMs:1000,
    clock:()=>{if(afterCurrent&&++reads===4){afterCurrent=false;wall+=elapsed;mono+=elapsed;consumed++;}return wall;},
    monotonic:()=>mono,
    transport:async kind=>{calls.push(kind);if(kind==='current')afterCurrent=true;
      return {ok:true,data:{state:'connected',expiresAtMs:100010,approvalUrl:null,confirmation:null}};},
    onChange:state=>phases.push(state.phase),onInvalidate:reason=>invalidations.push(reason),
    setTimer:(fn,ms)=>{const token={fn,ms};timers.add(token);return token;},clearTimer:token=>timers.delete(token),
  });
  t.after(()=>ui.reset());
  await ui.check();
  console.log(JSON.stringify({elapsed,consumed,calls,phases,phase:ui.state.phase,timers:timers.size}));
  assert.equal(consumed,1);assert.deepEqual(calls,['status','current']);
  if(elapsed<10){assert.equal(ui.state.phase,'connected');assert.equal(timers.size,1);}
  else{assert.equal(ui.state.phase,'expired');assert.equal(timers.size,0);
    assert.equal(phases.includes('connected'),false,'no transient proof success after its exact expiry');
    assert.equal(ui.state.expiredFrom,'connected');assert.deepEqual(invalidations,['lost']);}
});
test('generic invalid observation deadline does not call an unnecessary clock',async t=>{
  let clocks=0;
  const ui=createAiConnectController({observeGraceMs:NaN,clock:()=>{clocks++;throw Error('Clock must not run for an invalid deadline');},
    transport:async kind=>({ok:true,data:kind==='start'?{
      connectionId:id,state:'awaiting_approval',confirmation:'abcd-1234',expiresAt:new Date(110000).toISOString(),
      approvalUrl:`https://aleph-omega.vercel.app/workbench.html?appConnect=alekov&appDevice=${id}&appChallenge=${'A'.repeat(43)}`,
    }:{connectionId:id,state:'checking',expiresAt:null,reason:null}}),
    setTimer:()=>{throw Error('No timer for invalid deadline');},clearTimer:()=>{},
  });
  t.after(()=>ui.reset());await ui.start();await ui.finish();
  assert.equal(clocks,0);assert.equal(ui.state.phase,'unknown');assert.equal(ui.state.reason,'ALEKOV_CONNECT_TIMEOUT');
});

// One generation owns loss notification across accept, expiry and check cleanup.

for(const entry of ['initial','renewal'])test(`${entry} proof expiry emits one lost invalidation`,async t=>{
  let wall=100000,mono=0,armed=false,afterCurrent=false,reads=0,consumed=0;
  const calls=[],phases=[],invalidations=[],timers=new Set();
  const ui=createNativeLoginController({actionMs:1000,
    clock:()=>{if(afterCurrent&&++reads===4){afterCurrent=false;wall+=10;mono+=10;consumed++;}return wall;},
    monotonic:()=>mono,
    transport:async kind=>{calls.push(kind);if(kind==='current'&&armed){afterCurrent=true;reads=0;}
      return {ok:true,data:{state:'connected',expiresAtMs:100010,approvalUrl:null,confirmation:null}};},
    onChange:state=>phases.push(state.phase),onInvalidate:reason=>invalidations.push(reason),
    setTimer:(fn,ms)=>{const timer={fn,ms};timers.add(timer);return timer;},clearTimer:timer=>timers.delete(timer),
  });
  t.after(()=>ui.reset());
  if(entry==='renewal'){
    await ui.check();assert.equal(ui.state.phase,'connected');assert.equal(timers.size,1);
    assert.deepEqual(invalidations,[]);calls.length=0;phases.length=0;
  }
  armed=true;
  await ui.check();
  const observed={entry,calls,phases,invalidations,phase:ui.state.phase,expiredFrom:ui.state.expiredFrom,timers:timers.size,consumed};
  console.log('BEFORE_FALLBACK '+JSON.stringify(observed));
  assert.equal(consumed,1);assert.equal(ui.state.phase,'expired');assert.equal(ui.state.expiredFrom,'connected');
  assert.equal(timers.size,0);assert.equal(phases.includes('connected'),false);
  assert.deepEqual(calls,entry==='renewal'?['current']:['status','current']);
  assert.deepEqual(invalidations,['lost'],'the same expiry transition must not notify its external observer twice');
});

for(const reentrant of [false,true])test(`immediate renewal expiry ${reentrant?'preserves a reentrant newer generation':'emits one loss notification'}`,async t=>{
  let wall=100000,mono=0,proofEnd=100010,expireOnPublish=false,replaceOnLoss=false,replacement;
  const invalidations=[],timers=new Set(),publications=[];
  const ui=createNativeLoginController({clock:()=>wall,monotonic:()=>mono,
    transport:async()=>({ok:true,data:{state:'connected',expiresAtMs:proofEnd,approvalUrl:null,confirmation:null}}),
    onChange:state=>{
      publications.push({phase:state.phase,at:wall,expiresAtMs:state.expiresAtMs});
      if(state.phase==='connected'&&expireOnPublish){
        expireOnPublish=false;assert.ok(wall<state.expiresAtMs,'the published proof was valid before its observer used time');
        wall+=10;mono+=10;
      }
    },
    onInvalidate:reason=>{invalidations.push(reason);if(reason==='lost'&&replaceOnLoss){
      replaceOnLoss=false;proofEnd=wall+10;replacement=ui.check();
    }},
    setTimer:(fn,ms)=>{const timer={fn,ms};timers.add(timer);return timer;},clearTimer:timer=>timers.delete(timer),
  });
  t.after(async()=>{ui.reset();await replacement;});
  await ui.check();assert.equal(ui.state.phase,'connected');assert.equal(timers.size,1);
  expireOnPublish=true;replaceOnLoss=reentrant;
  await ui.check();await replacement;
  assert.deepEqual(invalidations,['lost'],'one generation owns its loss notification');
  if(reentrant){
    assert.equal(ui.state.phase,'connected');assert.equal(timers.size,1);
    const [timer]=timers;wall+=10;mono+=10;timers.delete(timer);timer.fn();
    assert.deepEqual(invalidations,['lost','lost'],'a distinct generation retains its own loss notification');
  }
  assert.equal(ui.state.phase,'expired');assert.equal(ui.state.expiredFrom,'connected');assert.equal(timers.size,0);
  assert.ok(publications.filter(x=>x.phase==='connected').every(x=>x.at<x.expiresAtMs));
});
