import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {test} from 'node:test';
import {nativeFault,nativeOwn,nativeSignal} from '../src/connection/native-login.mjs';

const source=await readFile(new URL('../src/connection/native-context.mjs',import.meta.url),'utf8');
function section(from,to){
  const start=source.indexOf(from),end=source.indexOf(to,start);
  assert.ok(start>=0&&end>start,'production lifetime section must be present');
  return source.slice(start,end).replace(/^export /gm,'');
}
const production=section('function state(host)','// 고정 helper만 실행한다.')+
  section('export async function openNativeHostOperation(','export function createNativeOperationVault(');

// Execute the actual acquisition/validation/disposal functions. Only native
// platform dependencies are synthetic; these checks make no registry/ACL claim.
function fixture(failure){
  const host={},loginCap={},hosts=new WeakMap(),operations=new WeakMap(),controller=new AbortController();
  const calls={open:0,binding:0,registry:0,refresh:0,physical:0,assert:0,close:0};
  const s={login:{},config:{projectRoot:'fixture-project'},configFile:null,project:null,projectGeneration:0,closed:false,operations:new Set()};
  hosts.set(host,s);
  const expected=nativeFault('UNVERIFIED');
  const hit=(name)=>{calls[name]++;if(failure===name)throw expected;};
  const canonical={canonicalStudentId:'fixture-student',alephUserId:'fixture-user',siteId:'fixture-site',identityVersion:1};
  const dependencies={hosts,operations,nativeFault,nativeOwn,nativeSignal,
    openNativeOperation:async()=>{hit('open');return loginCap;},
    nativeOperationBinding:cap=>{assert.equal(cap,loginCap);hit('binding');return {deadline:10000,signal:controller.signal,nativeInstance:'fixture-instance',generation:1};},
    refreshNativeOperation:async cap=>{assert.equal(cap,loginCap);hit('refresh');},
    closeNativeOperation:cap=>{assert.equal(cap,loginCap);calls.close++;controller.abort();},
    assertNativeOperation:cap=>{assert.equal(cap,loginCap);calls.assert++;if(failure===`assert${calls.assert}`)throw expected;return canonical;},
    physical:()=>{hit('physical');if(failure==='changed-project'&&calls.physical===2)return 'replacement';return 'same-project';},
    randomUUID:()=>{if(failure==='uuid')throw expected;return 'fixture-operation';},
    registry:async(_state,_request,_signal,work)=>{hit('registry');
      const raw={projectId:'fixture-project-id',directoryInstance:'fixture-directory',registryRevision:1};
      if(failure==='selected')raw.registryRevision='invalid';
      const selected=await work(raw);if(failure==='host-closed')s.closed=true;return selected.value;
    },
  };
  const api=runInNewContext(production+'\n({openNativeHostOperation,closeNativeHostOperation,assertNativeHostOperation});',dependencies);
  return {host,s,calls,expected,...api};
}

test('host acquisition transfers ownership only after successful validation and closes idempotently',async()=>{
  const f=fixture();const cap=await f.openNativeHostOperation(f.host,{});
  assert.equal(f.s.operations.size,1);assert.equal(f.calls.close,0);
  assert.equal(f.assertNativeHostOperation(f.host,cap).projectId,'fixture-project-id');
  f.closeNativeHostOperation(cap);f.closeNativeHostOperation(cap);
  assert.equal(f.calls.close,1);assert.equal(f.s.operations.size,0);
  assert.throws(()=>f.assertNativeHostOperation(f.host,cap),error=>error.code==='NATIVE_HOST_CONTEXT_CHANGED');
});

for(const failure of ['open','binding','registry','selected','refresh','physical','uuid','assert1','assert2','changed-project','host-closed']){
  test(`host acquisition releases partial ownership after ${failure} failure`,async()=>{
    const f=fixture(failure);
    await assert.rejects(f.openNativeHostOperation(f.host,{}),error=>failure==='selected'
      ?error.code==='NATIVE_HOST_RESPONSE_INVALID':failure==='changed-project'
        ?error.code==='NATIVE_HOST_CONTEXT_CHANGED':error===f.expected||failure==='host-closed'&&error.code==='NATIVE_HOST_UNVERIFIED');
    assert.equal(f.calls.close,failure==='open'?0:1,'every acquired login capability is closed exactly once');
    assert.equal(f.s.operations.size,0,'a failed open cannot retain an unreachable host capability');
    if(failure==='binding')assert.equal(f.calls.registry,0,'binding failure must stop before native registry work');
  });
}
