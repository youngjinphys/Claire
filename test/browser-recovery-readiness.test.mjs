import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import vm from 'node:vm';
import {OPS_TRACE_STATE} from '../scripts/browser-request-trace.mjs';

const source=await readFile(new URL('../scripts/operations-chart-browser-smoke.mjs',import.meta.url),'utf8');
function section(from,to){
  const start=source.indexOf(from),end=source.indexOf(to,start+from.length);
  assert.ok(start>=0&&end>start,'actual smoke helper section exists');return source.slice(start,end);
}
const helpers=section('const sleep=','const fixture=');
const reader=section('    const recoveryState=','    const assertRecovery=');
const assertions=section('    const assertRecovery=','    for(const mode of');
// CDP returns plain host-realm data. Keep the unmodified assertion's array
// literals in that same realm so strict equality still checks real values.
const assertRecovery=Function('assert',assertions+'; return assertRecovery;')(assert);

function pageFixture(){
  const element=()=>({
    hidden:false,inert:false,disabled:false,readOnly:false,parentElement:null,textContent:'',
    style:{display:'block',visibility:'visible',opacity:'1'},attributes:new Map(),
    getAttribute(name){return this.attributes.get(name)??null;},
    getClientRects(){return this.hidden?[]:[{width:100,height:30}];},
  });
  const body=element(),operationsParent=element();operationsParent.parentElement=body;
  const nodes=new Map(['device-panel','device-state','device-detail','device-enroll','device-unlock','device-refresh',
    'email','password','signed-out','workspace','ops-refresh','ops-state','login-submit'].map(id=>{
    const node=element();node.parentElement=body;return [id,node];
  }));
  const node=id=>nodes.get(id),refresh=node('ops-refresh');refresh.parentElement=operationsParent;
  node('device-state').attributes.set('role','status');node('device-state').attributes.set('aria-live','polite');
  node('device-detail').textContent='기기 검증 화면을 불러오지 못했습니다. 브라우저 새로고침으로 다시 시도하세요.';
  for(const id of ['device-enroll','device-unlock','device-refresh'])node(id).disabled=true;
  node('workspace').hidden=true;
  const trace={started:1,active:0},clicks=[];let queued=false;
  refresh.click=()=>{
    assert.equal(refresh.hidden,false);assert.equal(operationsParent.hidden,false);
    assert.equal(refresh.disabled,false);assert.equal(refresh.getAttribute('aria-disabled'),'false');
    clicks.push({started:trace.started});queued=true;refresh.attributes.set('aria-disabled','true');
  };
  const win={[OPS_TRACE_STATE]:trace,__qaDeviceModule:{evaluated:1,initializations:0}};
  const doc={readyState:'loading',getElementById:node,querySelector:selector=>{
    assert.equal(selector,'#login-form button[type="submit"]');return node('login-submit');
  }};
  return {node,trace,clicks,window:win,document:doc,
    context:vm.createContext({window:win,document:doc,getComputedStyle:node=>node.style,performance:{now:()=>10001}}),
    phase(value){
      refresh.hidden=false;refresh.disabled=false;operationsParent.hidden=false;
      refresh.attributes.set('aria-disabled','false');trace.active=0;
      node('device-state').textContent='기기 검증 화면 로드 실패';
      node('ops-state').textContent='실측 관측 완료 · 공식 심판 판정 별도';
      if(value==='queued')refresh.attributes.set('aria-disabled','true');
      if(value==='body'){
        refresh.attributes.set('aria-disabled','true');node('ops-state').textContent='HTTP 관측 중 · 완료 전 수치 변경 없음';
      }
      if(value==='hidden')operationsParent.hidden=true;
      if(value==='disabled')refresh.disabled=true;
      if(value==='active')trace.active=1;
      if(value==='device-pending')node('device-state').textContent='기기 확인 중';
    },
    completeRefresh(){assert.equal(queued,true);queued=false;trace.started++;refresh.attributes.set('aria-disabled','false');},
  };
}

function fixture({phases=['ready'],beforeRead=()=>{}}={}){
  const page=pageFixture(),snapshots=[],diagnostics=[];let now=0,reads=0,sleeps=0;
  const context=vm.createContext({assert,OPS_TRACE_STATE,Date:{now:()=>now},
    setTimeout(fn,delay){assert.equal(delay,50);now+=delay;sleeps++;fn();},
    console:{error(...args){diagnostics.push(args);}},
    async evaluate(expression){
      page.phase(phases[Math.min(reads,phases.length-1)]);beforeRead(page,reads++);
      const state=JSON.parse(JSON.stringify(vm.runInContext(expression,page.context)));
      snapshots.push(state);return state;
    },
  });
  const api=vm.runInContext(helpers+reader+
    '\n({until,recoverySnapshotReady,waitForRecoverySnapshot,recoveryState});',context);
  api.assertRecovery=assertRecovery;
  return {page,api,snapshots,diagnostics,get reads(){return reads;},get elapsed(){return now;},get sleeps(){return sleeps;},
    wait(activate=false){return api.waitForRecoverySnapshot(()=>api.recoveryState(activate),api.until,'synthetic recovery');},
  };
}

test('queued and body-pending observations cannot satisfy the actual recovery snapshot waiter',async()=>{
  const x=fixture({phases:['queued','body','ready']});
  const state=await x.wait();
  assert.equal(x.reads,3);assert.equal(x.elapsed,100);
  assert.equal(x.snapshots[0].operationsState.includes('실측 관측 완료'),true);
  assert.equal(x.snapshots[0].operationsActive,0);assert.equal(x.snapshots[0].operationsAriaDisabled,'true');
  assert.equal(x.snapshots[1].operationsActive,0);assert.equal(x.snapshots[1].operationsUsable,false);
  assert.strictEqual(state,x.snapshots[2],'the captured ready object is returned without another evaluation');
  x.api.assertRecovery(state);assert.equal(x.diagnostics.length,0);
});

test('readiness from different snapshots cannot be combined into a false success',async()=>{
  const x=fixture({beforeRead(page,index){page.phase(index%2===0?'queued':'device-pending');}});
  await assert.rejects(x.wait(),/Chart browser QA timeout: synthetic recovery/u);
  assert.equal(x.elapsed,15000);assert.equal(x.reads,300);
  assert.ok(x.snapshots.some(state=>state.statusText==='기기 검증 화면 로드 실패'));
  assert.ok(x.snapshots.some(state=>state.operationsUsable));
  assert.equal(x.snapshots.some(state=>x.api.recoverySnapshotReady(state)),false);
});

for(const phase of ['queued','body','hidden','disabled','active'])
test(`permanently ${phase} operations fails at the unchanged 15 second deadline`,async()=>{
  const x=fixture({phases:[phase]});
  await assert.rejects(x.wait(),/Chart browser QA timeout: synthetic recovery/u);
  assert.equal(x.elapsed,15000);assert.equal(x.sleeps,300);assert.equal(x.reads,300);
  assert.equal(x.diagnostics.length,1);
  const [label,json]=x.diagnostics[0];assert.equal(label,'Chart browser recovery readiness:');
  assert.deepEqual(Object.keys(JSON.parse(json)),['active','started','disabled','ariaDisabled','visible']);
  assert.doesNotMatch(json,/기기|proof|email|password|detailText/u);
  assert.equal(x.page.clicks.length,0);
});

test('a ready snapshot is returned directly even if a hypothetical next read would be busy',async()=>{
  const x=fixture({phases:['ready','queued']});
  const state=await x.wait();
  assert.strictEqual(state,x.snapshots[0]);assert.equal(x.reads,1);assert.equal(x.elapsed,0);
  x.api.assertRecovery(state);
});

test('manual activation checks readiness, captures the prior count and clicks in one evaluation',async()=>{
  const x=fixture({phases:['queued','body','ready']});
  const state=await x.wait(true);
  assert.equal(x.reads,3);assert.equal(x.page.clicks.length,1);
  assert.strictEqual(state,x.snapshots[2]);assert.equal(state.operationsStarted,1);
  assert.equal(state.operationsUsable,true,'the returned snapshot describes the moment before the click');
  assert.equal(x.page.node('ops-refresh').getAttribute('aria-disabled'),'true','the same evaluation already queued the action');
  assert.deepEqual(x.page.clicks,[{started:1}]);
  x.page.completeRefresh();assert.ok(x.page.trace.started>state.operationsStarted);
});

test('the snapshot waiter leaves visibility and locked-vault assertions intact',async()=>{
  const x=fixture({beforeRead(page){page.node('device-panel').hidden=true;}});
  const state=await x.wait();assert.equal(x.reads,1);
  assert.throws(()=>x.api.assertRecovery(state),/module recovery is rendered through every ancestor/u);
  const y=fixture({beforeRead(page){page.node('workspace').hidden=false;}});
  const unlocked=await y.wait();
  assert.throws(()=>y.api.assertRecovery(unlocked),/module failure never opens the vault/u);
});

test('the intentionally held module need not complete document loading before deadline recovery is inspected',async()=>{
  const x=fixture({beforeRead(page){page.window.__qaDeviceModule=null;}});
  const state=await x.wait();assert.equal(x.page.document.readyState,'loading');
  assert.equal(state.module,null);assert.equal(state.elapsed,10001);assert.equal(x.elapsed,0);
  x.api.assertRecovery(state);
});

test('the original evaluation error is rethrown without suppressing or reclassifying CDP failures',async()=>{
  const x=fixture(),error=Object.assign(Error('CDP Fetch.continueRequest: Invalid InterceptionId.'),{cdpCode:-32602});
  await assert.rejects(x.api.waitForRecoverySnapshot(async()=>{throw error;},x.api.until,'synthetic CDP failure'),actual=>actual===error);
  assert.equal(error.cdpCode,-32602);assert.equal(x.diagnostics.length,1);assert.equal(x.elapsed,0);
  assert.deepEqual(JSON.parse(x.diagnostics[0][1]),{active:null,started:null,disabled:null,ariaDisabled:null,visible:null});
});
