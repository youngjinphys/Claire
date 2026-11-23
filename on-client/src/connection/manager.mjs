// Alekov 학생 AI 연결 관리자 — 서버 전용. 브라우저로 내보내지 않으며 HTTP 를 직접 열거나 mount 하지 않는다.
// root(Codex)가 POST /api/ai/connect/{start,finish,status,cancel} 경계에 아래 메서드를 연결한다.
// verifier·token·credential·private handle·기대 scope 는 이 프로세스 메모리와 native SDK·vault sink 안에만 있다.
// 공개 응답은 고정 필드만 새로 만들어 돌려준다. 자동 재시도·재발급·grant 회수는 하지 않는다.
import {createAlekovAppConnector,ALEPH_PORTAL_ORIGIN} from '../ai/connection.mjs';
import {types} from 'node:util';
import {nativeOwn} from './native-login.mjs';
import {ownedDeadlineTimer} from '../../public/deadline-timer.mjs';
import {isNativeHostContext,openNativeHostOperation,readNativeHostOperation,assertNativeHostOperation,assertNativeHostContinuity,createNativeOperationVault,closeNativeHostOperation} from './native-context.mjs';

export const CONNECTION_SCOPE_SCHEMA='aleph.on.ai-identity.v1';
export const PUBLIC_STATES=Object.freeze(['awaiting_approval','checking','connected','error','unknown','cancelled']);
const SCOPE=['schema','sourceSubjectId','canonicalStudentId','alephUserId','siteId','identityVersion','projectId','sessionId'];
const TERMINAL=new Set(['connected','error','unknown','cancelled']);
// 확정 실패: 자격이 생기지 않았다고 볼 수 있는 경우만 error. 나머지는 unknown(자동 회수·재시도 없음).
const DEFINITE=new Set(['ALEKOV_CONNECT_EXPIRED','ALEKOV_CONNECT_REJECTED','ALEKOV_CONNECT_UNAVAILABLE']);
const MESSAGES=Object.freeze({
  ALEKOV_CONNECT_INPUT_INVALID:'요청 형식이 올바르지 않습니다.',
  ALEKOV_CONNECT_UNAVAILABLE:'AI 연결 기능이 아직 준비되지 않았습니다. 기존 설명·판정·기록은 그대로 쓸 수 있습니다.',
  ALEKOV_CONNECT_CONTEXT_UNVERIFIED:'현재 로그인·프로젝트를 확인할 수 없습니다. 다시 로그인한 뒤 연결을 시작하세요.',
  ALEKOV_CONNECT_CONTEXT_CHANGED:'계정·프로젝트·세션이 바뀌어 이전 연결 진행을 멈췄습니다. 현재 화면에서 연결을 새로 시작하세요.',
  ALEKOV_CONNECT_NOT_FOUND:'연결 요청을 찾을 수 없습니다. 연결을 새로 시작하세요.',
  ALEKOV_CONNECT_BUSY:'진행 중인 연결 요청이 너무 많습니다. 기존 요청을 취소하거나 끝낸 뒤 다시 시작하세요.',
  ALEKOV_CONNECT_EXPIRED:'승인 기한이 지났습니다. 연결을 새로 시작하세요.',
  ALEKOV_CONNECT_REJECTED:'연결 요청이 거절됐습니다. 승인한 계정이 현재 로그인과 같은지 확인한 뒤 새로 시작하세요.',
  ALEKOV_CONNECT_OUTCOME_UNKNOWN:'연결 결과를 확인할 수 없습니다. 자동으로 다시 시도하지 않습니다. 담당자에게 확인을 요청하세요.',
  ALEKOV_CONNECT_DEADLINE:'현재 로그인 확인이나 서버 처리가 늦어 이 요청을 멈췄습니다. 자동으로 다시 시도하지 않습니다. 잠시 뒤 직접 다시 누르세요.',
});
// 기한·취소 경계. 늦게 끝난 원천 값은 버리고, 그 값으로 다음 단계를 시작하지 않는다.
const TIMEOUT=Symbol('timeout'),ABORTED=Symbol('aborted');
const now=()=>performance.now();
const expired=(deadline,signal)=>signal?.aborted||now()>=deadline;
function remainingUntil(deadline,signal){
  if(signal?.aborted)throw ABORTED;
  const left=deadline-now();
  if(signal?.aborted)throw ABORTED;
  if(left<=0)throw TIMEOUT;
  return left;
}
// Callers keep this absolute deadline through their own final await continuation.
function within(work,deadline,signal){
  if(signal?.aborted)return Promise.resolve(ABORTED);
  const result=value=>signal?.aborted?ABORTED:now()>=deadline?TIMEOUT:value;
  return new Promise(resolve=>{
    let done=false;
    const onAbort=()=>finish(ABORTED);
    const finish=value=>{if(done)return;done=true;timer.dispose();signal?.removeEventListener('abort',onAbort);resolve(value);};
    const timer=ownedDeadlineTimer(()=>remainingUntil(deadline,signal),cause=>finish(late(cause)?cause:result(null)));
    timer.arm(Math.max(0,deadline-now()));
    signal?.addEventListener('abort',onAbort,{once:true});
    if(signal?.aborted)onAbort();
    Promise.resolve().then(()=>{const before=result(undefined);return before===undefined?work():before;}).then(value=>finish(result(value)),()=>finish(result(null)));
  });
}
const late=v=>v===TIMEOUT||v===ABORTED;
const REASONS=new Set(['ALEKOV_CONNECT_CONTEXT_UNVERIFIED','ALEKOV_CONNECT_CONTEXT_CHANGED','ALEKOV_CONNECT_CANCELLED','ALEKOV_CONNECT_UNAVAILABLE','ALEKOV_CONNECT_TIMEOUT',
  'ALEKOV_CONNECT_OUTCOME_UNKNOWN','ALEKOV_CONNECT_REDIRECT_BLOCKED','ALEKOV_CONNECT_REJECTED','ALEKOV_CONNECT_RESPONSE_INVALID','ALEKOV_CONNECT_HANDLE_INVALID',
  'ALEKOV_CONNECT_EXPIRED','ALEKOV_CONNECT_STORAGE_UNVERIFIED']);
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
const exact=(v,keys)=>plain(v)&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k),'value'));
const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/.test(v);
const project=v=>id(v)&&v.length<=199&&!v.includes('..')&&!/^(?:[a-z]:|file:|sk-|sb_secret_|eyJ|bearer(?:$|[._:@-])|token(?:$|[._:@-]))/i.test(v);
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const iso=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const positive=v=>Number.isSafeInteger(v)&&v>0;
const bounded=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const validScope=v=>exact(v,SCOPE)&&v.schema===CONNECTION_SCOPE_SCHEMA&&positive(v.identityVersion)
  &&SCOPE.filter(k=>k!=='schema'&&k!=='identityVersion').every(k=>id(v[k]));
const sameScope=(a,b)=>!!a&&!!b&&SCOPE.every(k=>a[k]===b[k]);
const own=code=>Object.assign(new Error(code),{code});
const reply=(status,body)=>Object.freeze({status,body});
const failure=(status,code)=>reply(status,{ok:false,error:{code,message:MESSAGES[code]??MESSAGES.ALEKOV_CONNECT_OUTCOME_UNKNOWN}});
const startCode=code=>REASONS.has(code)&&MESSAGES[code]?code:'ALEKOV_CONNECT_OUTCOME_UNKNOWN';
const startStatus=code=>code==='ALEKOV_CONNECT_UNAVAILABLE'?503:code.startsWith('ALEKOV_CONNECT_CONTEXT_')?409:502;

// Both managers retain terminal history while space remains. Under pressure,
// reclaim only the oldest completed records; live flows and pending starts count.
function capacity(flows,starting,maxFlows){
  if(flows.size+starting<maxFlows)return true;
  const done=[...flows].filter(([,f])=>TERMINAL.has(f.state)).sort(([,a],[,b])=>a.completionOrder<b.completionOrder?-1:a.completionOrder>b.completionOrder?1:0);
  for(const [key] of done){flows.delete(key);if(flows.size+starting<maxFlows)return true;}
  return false;
}
// Wall timestamps describe observations; relative retention and completion order
// must survive clock corrections and completions within the same monotonic tick.
function createTerminalRecorder(){
  let order=0n;
  return flow=>{flow.settledMono=now();flow.completionOrder=++order;};
}
// Terminal timestamps are optional observations. Approval/acceptance checks
// still read their required wall clock directly and do not use this fallback.
function terminalTimestamp(clock){
  try{const at=clock();return Number.isFinite(at)?at:null;}catch{return null;}
}

/** 승인 URL 은 현재 고정 ALEPH origin 의 Workbench 전용 query 만 허용한다. */
export function isWorkbenchApprovalUrl(value,connectionId,projectId){
  let url;try{url=new URL(value);}catch{return false;}
  if(url.href!==value||url.origin!==ALEPH_PORTAL_ORIGIN||url.pathname!=='/workbench.html'||url.hash||url.username||url.password)return false;
  const keys=[...url.searchParams.keys()];
  if(url.searchParams.get('appConnect')!=='alekov'||url.searchParams.get('appDevice')!==connectionId||!/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('appChallenge')??''))return false;
  // Two-argument historical callers may validate exact3. A current native flow
  // supplies its trusted project and therefore requires the registration exact5.
  if(keys.join(',')==='appConnect,appDevice,appChallenge')return projectId===undefined;
  const expected=url.searchParams.get('appProject');
  return keys.join(',')==='appConnect,appDevice,appChallenge,appRegistration,appProject'&&url.searchParams.get('appRegistration')==='v1'
    &&project(expected)&&(projectId===undefined||project(projectId)&&expected===projectId);
}

/**
 * readServerScope: 호스트가 검증한 현재 scope(aleph.on.ai-identity.v1, 8필드)를 돌려주는 함수. 없으면 비활성.
 * vault.persistCredential: 비공개 sink. 결과(ack)는 SDK 와 이 관리자만 본다.
 * fetchImpl: 명시적 테스트 seam. gateway/portal origin 은 SDK 고정값을 그대로 쓴다.
 * 모든 메서드는 {status, body} 를 돌려주며 body 는 {ok:true,data} 또는 고정 {ok:false,error:{code,message}} 이다.
 */
export function createConnectionManager(options={}){
  if(!options||typeof options!=='object'||types.isProxy(options))throw Error('INVALID_SERVER_CONNECTION_CONFIGURATION');
  const d=Object.getOwnPropertyDescriptor(options,'nativeHost');
  if(d){if(!Object.hasOwn(d,'value')||!d.enumerable||!isNativeHostContext(d.value))throw Error('INVALID_SERVER_CONNECTION_CONFIGURATION');return createNativeManager(options,d.value);}
  for(let p=Object.getPrototypeOf(options);p;p=Object.getPrototypeOf(p)){if(types.isProxy(p)||Object.getOwnPropertyDescriptor(p,'nativeHost'))throw Error('INVALID_SERVER_CONNECTION_CONFIGURATION');}
  const {enabled=false,readServerScope,vault,fetchImpl=globalThis.fetch,clock=Date.now,
    startTimeoutMs=15000,scopeTimeoutMs=5000,finishTimeoutMs=420000,pollIntervalMs=2000,maxFlows=8,retainMs=600000}=options;
  const configured=enabled===true&&typeof readServerScope==='function'&&typeof vault?.persistCredential==='function'&&typeof fetchImpl==='function'
    &&typeof clock==='function'&&bounded(startTimeoutMs,1,60000)&&bounded(scopeTimeoutMs,1,60000)&&bounded(finishTimeoutMs,1,420000)&&bounded(pollIntervalMs,1,10000)
    &&bounded(maxFlows,1,32)&&bounded(retainMs,1,3600000);
  const persist=configured?vault.persistCredential.bind(vault):null;
  // 동시 연결 흐름 상한(메모리 보호). 운영 AI 사용 횟수 제한이 아니다.
  const flows=new Map(),pendingControllers=new Set(),recordTerminal=createTerminalRecorder();let starting=0,closed=false;

  // 호스트가 검증한 현재 scope 만 읽는다. body·URL·env·학생 hook 값으로 신원을 만들지 않는다.
  async function readScope(){if(closed)return null;let v;try{v=structuredClone(await readServerScope());}catch{return null;}return validScope(v)?Object.freeze(v):null;}
  const view=f=>({connectionId:f.id,state:f.state,expiresAt:f.expiresAt,reason:f.reason});
  function settle(flow,state,reason=null,settledAt){
    if(TERMINAL.has(flow.state))return;
    const controller=flow.controller,timer=flow.timer;flow.controller=null;flow.timer=null;
    flow.state=state;flow.reason=reason;flow.settledAt=settledAt??null;recordTerminal(flow);flow.handle=null;flow.connector=null;
    timer?.dispose();controller?.abort();
    if(settledAt===undefined)flow.settledAt=terminalTimestamp(clock);
  }
  function prune(){
    const at=clock();
    for(const [key,flow] of flows){
      if(flow.state==='awaiting_approval'&&at>=flow.expiresMs)settle(flow,'error','ALEKOV_CONNECT_EXPIRED');
      if(TERMINAL.has(flow.state)&&now()-flow.settledMono>=retainMs)flows.delete(key);
    }
  }
  // 계정·프로젝트·세션·신원 버전 전환: 진행을 멈추고 옛 결과를 정상으로 표시하지 않는다.
  function interrupt(flow,code,settledAt){if(flow.state==='awaiting_approval')settle(flow,'cancelled',code,settledAt);else if(flow.state==='checking')settle(flow,'unknown',code,settledAt);}
  // 요청 signal 은 조회 대기만 끝낸다. 원천이 끝나지 않거나 늦으면 흐름을 바꾸지 않고 고정 504.
  async function locate(input,signal,deadline){
    if(!exact(input,['connectionId'])||!uuid(input.connectionId))return {reply:failure(400,'ALEKOV_CONNECT_INPUT_INVALID')};
    if(!configured||closed)return {reply:failure(503,'ALEKOV_CONNECT_UNAVAILABLE')};
    if(expired(deadline,signal))return {reply:failure(504,'ALEKOV_CONNECT_DEADLINE')};
    const flow=flows.get(input.connectionId);if(!flow)return {reply:failure(404,'ALEKOV_CONNECT_NOT_FOUND')};
    const scope=await within(readScope,deadline,signal);
    if(closed)return {reply:failure(503,'ALEKOV_CONNECT_UNAVAILABLE')};
    if(late(scope)||expired(deadline,signal))return {reply:failure(504,'ALEKOV_CONNECT_DEADLINE')};
    // No flow mutation here: the public caller still has an await to cross.
    return {flow,scope};
  }
  function accept(found,signal,deadline){
    if(closed)return failure(503,'ALEKOV_CONNECT_UNAVAILABLE');
    if(expired(deadline,signal))return failure(504,'ALEKOV_CONNECT_DEADLINE');
    if(found.reply)return found.reply;
    const {flow,scope}=found,at=clock();
    if(closed)return failure(503,'ALEKOV_CONNECT_UNAVAILABLE');
    if(expired(deadline,signal))return failure(504,'ALEKOV_CONNECT_DEADLINE');
    if(flows.get(flow.id)!==flow)return failure(404,'ALEKOV_CONNECT_NOT_FOUND');
    found.acceptedAt=at;
    if(TERMINAL.has(flow.state)&&now()-flow.settledMono>=retainMs){flows.delete(flow.id);return failure(404,'ALEKOV_CONNECT_NOT_FOUND');}
    if(flow.state==='awaiting_approval'&&at>=flow.expiresMs)settle(flow,'error','ALEKOV_CONNECT_EXPIRED',at);
    if(flow.state==='checking'&&now()>=flow.deadline)settle(flow,'unknown','ALEKOV_CONNECT_TIMEOUT',at);
    if(!sameScope(scope,flow.scope)){
      const code=scope?'ALEKOV_CONNECT_CONTEXT_CHANGED':'ALEKOV_CONNECT_CONTEXT_UNVERIFIED';
      interrupt(flow,code,at);return failure(409,code);
    }
    return null;
  }

  // 기한은 최초 신원 조회 전부터 시작해 SDK 시작과 마지막 scope 재조회까지 같은 단조 시계로 잰다.
  // 선택 인자 {signal}(root HTTP mount 의 요청 수명)은 접수 준비만 끝낸다.
  // 기한·취소 뒤 늦게 끝난 원천 값으로 SDK begin·fetch·vault 저장을 시작하지 않고, 시작 슬롯은 항상 돌려준다.
  async function start(input,{signal}={}){
    if(!exact(input,[]))return failure(400,'ALEKOV_CONNECT_INPUT_INVALID');
    if(!configured||closed)return failure(503,'ALEKOV_CONNECT_UNAVAILABLE');
    prune();if(!capacity(flows,starting,maxFlows))return failure(429,'ALEKOV_CONNECT_BUSY');
    starting++;
    const deadline=now()+startTimeoutMs,controller=new AbortController(),stop=()=>controller.abort();
    pendingControllers.add(controller);
    const timer=setTimeout(stop,startTimeoutMs);
    if(signal?.aborted)stop();else signal?.addEventListener('abort',stop,{once:true});
    const stopped=()=>closed||expired(deadline,controller.signal),deadlineReply=()=>failure(504,'ALEKOV_CONNECT_DEADLINE');
    try{
      const scope=await within(readScope,deadline,controller.signal);
      if(late(scope)||stopped())return deadlineReply();
      if(!scope)return failure(409,'ALEKOV_CONNECT_CONTEXT_UNVERIFIED');
      const flow={id:null,scope,state:'starting',reason:null,expiresAt:null,expiresMs:0,handle:null,connector:null,controller:null,deadline:null,timer:null,settledAt:0,settledMono:0,completionOrder:0n,vaultAck:false};
      flow.connector=createAlekovAppConnector({enabled:true,fetchImpl,clock,timeoutMs:finishTimeoutMs,pollIntervalMs,
        // SDK 가 5필드 context 를 받기 전에 원래 8필드 scope 와 현재 scope 를 비교한다. 조회는 scopeTimeoutMs 안에서만 기다린다.
        resolveCurrentContext:async()=>{
          const signal=(flow.controller??controller).signal,scopeDeadline=Math.min(now()+scopeTimeoutMs,flow.deadline??deadline);
          const current=await within(readScope,scopeDeadline,signal);
          if(closed||current===ABORTED||signal.aborted)throw own('ALEKOV_CONNECT_CANCELLED');
          if(!current||current===TIMEOUT||expired(scopeDeadline,signal))throw own('ALEKOV_CONNECT_CONTEXT_UNVERIFIED');
          if(!sameScope(current,scope))throw own('ALEKOV_CONNECT_CONTEXT_CHANGED');
          return {subjectId:current.canonicalStudentId,alephUserId:current.alephUserId,siteId:current.siteId,identityVersion:current.identityVersion,projectId:current.projectId};
        },
        // 비공개 sink. 결과를 공개 응답에 싣지 않는다. 취소·전환 뒤에는 저장을 시작하지 않는다.
        persistCredential:async(value,options)=>{
          const owner=flow.controller,alive=()=>{
            if(closed||flow.state!=='checking'||!owner||flow.controller!==owner||owner.signal.aborted)throw own('ALEKOV_CONNECT_CANCELLED');
            if(now()>=flow.deadline)throw own('ALEKOV_CONNECT_TIMEOUT');
          };
          alive();
          const saved=await persist(value,options);
          alive();const acknowledged=exact(saved,['connectionId','credentialFingerprint','contextFingerprint','persisted'])&&saved.connectionId===flow.id&&saved.persisted===true;
          alive();flow.vaultAck=acknowledged;
          return saved;
        }});
      if(stopped())return deadlineReply();
      const begun=await within(()=>flow.connector.begin({signal:controller.signal}),deadline,controller.signal);
      if(late(begun)||stopped())return deadlineReply();
      if(begun?.ok!==true){const code=startCode(begun?.error?.code);return failure(startStatus(code),code);}
      const c=begun.connection;
      const valid=exact(c,['deviceId','approvalUrl','confirmation','expiresAt','state'])&&uuid(c.deviceId)&&c.state==='pending'&&iso(c.expiresAt)&&Date.parse(c.expiresAt)>clock()
        &&/^[0-9a-f]{4}-[0-9a-f]{4}$/.test(c.confirmation)&&isWorkbenchApprovalUrl(c.approvalUrl,c.deviceId,scope.projectId)&&!flows.has(c.deviceId);
      if(stopped())return deadlineReply();
      if(!valid)return failure(502,'ALEKOV_CONNECT_OUTCOME_UNKNOWN');
      const after=await within(readScope,deadline,controller.signal);
      if(late(after)||stopped())return deadlineReply();
      if(!sameScope(after,scope))return failure(409,after?'ALEKOV_CONNECT_CONTEXT_CHANGED':'ALEKOV_CONNECT_CONTEXT_UNVERIFIED');
      Object.assign(flow,{id:c.deviceId,state:'awaiting_approval',expiresAt:c.expiresAt,expiresMs:Date.parse(c.expiresAt),handle:begun.handle});
      if(stopped())return deadlineReply();
      flows.set(flow.id,flow);
      return reply(201,{ok:true,data:{connectionId:flow.id,approvalUrl:c.approvalUrl,confirmation:c.confirmation,expiresAt:c.expiresAt,state:'awaiting_approval'}});
    }finally{pendingControllers.delete(controller);starting--;clearTimeout(timer);signal?.removeEventListener('abort',stop);controller.abort();}
  }

  // 학생의 브라우저 로그인 시간을 HTTP 요청 수명에 묶지 않는다: 짧은 비공개 job 을 띄우고 바로 202/checking.
  // 요청 signal 은 접수 준비(scope 조회)까지만 쓴다. job 은 별도 controller·기한·scope 검사로만 멈추며
  // 202 를 돌려준 뒤 HTTP 응답이 닫혀도 취소되지 않는다.
  async function finish(input,{signal}={}){
    const lookupDeadline=now()+scopeTimeoutMs,found=await locate(input,signal,lookupDeadline),rejected=accept(found,signal,lookupDeadline);if(rejected)return rejected;
    const flow=found.flow;
    if(flow.state!=='awaiting_approval')return reply(flow.state==='checking'?202:200,{ok:true,data:view(flow)});
    const controller=new AbortController(),handle=flow.handle,connector=flow.connector;
    if(expired(lookupDeadline,signal))return failure(504,'ALEKOV_CONNECT_DEADLINE');
    const deadline=now()+finishTimeoutMs;
    flow.state='checking';flow.controller=controller;flow.deadline=deadline;flow.handle=null;
    const ownsTimer=()=>flow.timer===timer&&flow.controller===controller&&flow.state==='checking'&&flows.get(flow.id)===flow;
    const timer=ownedDeadlineTimer(()=>{
      if(!ownsTimer()||closed)throw ABORTED;
      const left=remainingUntil(deadline,controller.signal);
      if(!ownsTimer()||closed)throw ABORTED;
      return left;
    },cause=>{if(ownsTimer())settle(flow,'unknown',cause===TIMEOUT?'ALEKOV_CONNECT_TIMEOUT':cause===ABORTED?'ALEKOV_CONNECT_CANCELLED':'ALEKOV_CONNECT_OUTCOME_UNKNOWN');});
    flow.timer=timer;timer.arm(Math.max(0,deadline-now()));
    const alive=()=>{
      if(flow.controller!==controller||flow.state!=='checking')return false;
      if(now()>=deadline){settle(flow,'unknown','ALEKOV_CONNECT_TIMEOUT');return false;}
      if(closed||controller.signal.aborted){settle(flow,'unknown','ALEKOV_CONNECT_CANCELLED');return false;}
      return true;
    };
    const complete=(state,reason)=>{const at=terminalTimestamp(clock);if(alive())settle(flow,state,reason,at);};
    (async()=>{
      if(!alive())return;
      let result;try{result=await connector.complete(handle,{signal:controller.signal});}catch{result=null;}
      if(!alive())return; // 취소·전환·시간 초과가 먼저 확정됐다.
      const c=result?.ok===true?result.connection:null;
      if(c&&c.state==='connected'&&c.appId==='aleph-on'&&c.audience==='on-client'&&c.workbenchRequiredAtRuntime===false&&flow.vaultAck===true){
        const scopeDeadline=Math.min(deadline,now()+scopeTimeoutMs),current=await within(readScope,scopeDeadline,controller.signal);
        if(!alive())return;
        if(late(current)||!current||expired(scopeDeadline,controller.signal))return complete('unknown','ALEKOV_CONNECT_CONTEXT_UNVERIFIED');
        return sameScope(current,flow.scope)?complete('connected'):complete('unknown','ALEKOV_CONNECT_CONTEXT_CHANGED');
      }
      const code=REASONS.has(result?.error?.code)?result.error.code:c?'ALEKOV_CONNECT_STORAGE_UNVERIFIED':'ALEKOV_CONNECT_OUTCOME_UNKNOWN';
      complete(DEFINITE.has(code)?'error':'unknown',code);
    })().catch(()=>complete('unknown','ALEKOV_CONNECT_OUTCOME_UNKNOWN'));
    return reply(202,{ok:true,data:view(flow)});
  }

  async function status(input,{signal}={}){
    const deadline=now()+scopeTimeoutMs,found=await locate(input,signal,deadline),rejected=accept(found,signal,deadline);if(rejected)return rejected;
    return reply(200,{ok:true,data:view(found.flow)});
  }

  // 취소: 승인 대기면 cancelled. 확인 중이면 이미 생겼을 수 있는 grant 를 지우거나 회수하지 않고 unknown.
  async function cancel(input,{signal}={}){
    const deadline=now()+scopeTimeoutMs,found=await locate(input,signal,deadline),rejected=accept(found,signal,deadline);if(rejected)return rejected;
    const flow=found.flow;
    if(flow.state==='awaiting_approval')settle(flow,'cancelled','ALEKOV_CONNECT_CANCELLED',found.acceptedAt);
    else if(flow.state==='checking')settle(flow,'unknown','ALEKOV_CONNECT_CANCELLED',found.acceptedAt);
    return reply(200,{ok:true,data:view(flow)});
  }

  function close(){if(closed)return;closed=true;for(const controller of pendingControllers)controller.abort();pendingControllers.clear();for(const flow of flows.values())interrupt(flow,'ALEKOV_CONNECT_CANCELLED');flows.clear();}

  return Object.freeze({get available(){return configured&&!closed;},start,finish,status,cancel,close});
}

// native host5를 engine scope8로 바꾸지 않는다. 모든 callback은 시작 때의 원 operation을 사용한다.
function createNativeManager(raw,host){
  const config=nativeOwn(raw,['nativeHost'],['enabled','fetchImpl','clock','startTimeoutMs','finishTimeoutMs','pollIntervalMs','maxFlows','retainMs']);
  const fetchImpl=config.fetchImpl??globalThis.fetch,clock=config.clock??Date.now,startTimeoutMs=config.startTimeoutMs??15000,finishTimeoutMs=config.finishTimeoutMs??420000,pollIntervalMs=config.pollIntervalMs??2000,maxFlows=config.maxFlows??8,retainMs=config.retainMs??600000;
  if(config.enabled!==true||typeof fetchImpl!=='function'||types.isProxy(fetchImpl)||typeof clock!=='function'||types.isProxy(clock)||!bounded(startTimeoutMs,1,60000)||!bounded(finishTimeoutMs,1,420000)||!bounded(pollIntervalMs,1,10000)||!bounded(maxFlows,1,32)||!bounded(retainMs,1,3600000))throw Error('INVALID_SERVER_CONNECTION_CONFIGURATION');
  const flows=new Map(),pendingControllers=new Set(),recordTerminal=createTerminalRecorder();let closed=false,starting=0;
  const view=f=>({connectionId:f.id,state:f.state,expiresAt:f.expiresAt,reason:f.reason});
  function settle(f,status,reason=null,settledAt){
    if(TERMINAL.has(f.state))return;
    const timer=f.timer,controller=f.controller,cap=f.cap;f.timer=null;f.controller=null;
    f.state=status;f.reason=reason;f.settledAt=settledAt??null;recordTerminal(f);f.connector=null;f.handle=null;
    timer?.dispose();controller?.abort();closeNativeHostOperation(cap);
    if(settledAt===undefined)f.settledAt=terminalTimestamp(clock);
  }
  function prune(){for(const [key,f] of flows){if(f.state==='awaiting_approval'&&clock()>=Date.parse(f.expiresAt))settle(f,'error','ALEKOV_CONNECT_EXPIRED');if(TERMINAL.has(f.state)&&now()-f.settledMono>=retainMs)flows.delete(key);}}
  async function locate(input,signal,deadline){
    if(!exact(input,['connectionId'])||!uuid(input.connectionId))return {reply:failure(400,'ALEKOV_CONNECT_INPUT_INVALID')};
    if(closed)return {reply:failure(503,'ALEKOV_CONNECT_UNAVAILABLE')};
    if(expired(deadline,signal))return {reply:failure(504,'ALEKOV_CONNECT_DEADLINE')};
    const f=flows.get(input.connectionId);if(!f)return {reply:failure(404,'ALEKOV_CONNECT_NOT_FOUND')};
    if(f.state==='connected'){
      let current;const controller=new AbortController(),abort=()=>controller.abort();pendingControllers.add(controller);signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted)abort();
      try{
        const observed=await within(async()=>{
          try{
            const opened=await openNativeHostOperation(host,{signal:controller.signal,timeoutMs:Math.max(1,Math.ceil(deadline-now()))});
            if(closed||expired(deadline,controller.signal)){closeNativeHostOperation(opened);return null;}
            current=opened;assertNativeHostContinuity(host,f.cap,current);return {valid:true};
          }catch(error){return {error};}
        },deadline,controller.signal);
        if(closed)return {reply:failure(503,'ALEKOV_CONNECT_UNAVAILABLE')};
        if(late(observed)||expired(deadline,signal)||['NATIVE_HOST_TIMEOUT','NATIVE_HOST_CANCELLED','NATIVE_HOST_EXPIRED'].includes(observed?.error?.code))return {reply:failure(504,'ALEKOV_CONNECT_DEADLINE')};
        return {flow:f,scopeValid:observed?.valid===true};
      }finally{pendingControllers.delete(controller);signal?.removeEventListener('abort',abort);controller.abort();closeNativeHostOperation(current);}
    }else if(!TERMINAL.has(f.state)){
      const result=await within(()=>readNativeHostOperation(host,f.cap),deadline,signal);
      if(closed)return {reply:failure(503,'ALEKOV_CONNECT_UNAVAILABLE')};
      if(late(result)||expired(deadline,signal))return {reply:failure(504,'ALEKOV_CONNECT_DEADLINE')};
      let valid=true;
      try{if(!result)throw Error('unverified');assertNativeHostOperation(host,f.cap);}
      catch{valid=false;}
      return {flow:f,scopeValid:valid};
    }
    return {flow:f,scopeValid:true};
  }
  function accept(found,signal,deadline){
    if(closed)return failure(503,'ALEKOV_CONNECT_UNAVAILABLE');
    if(expired(deadline,signal))return failure(504,'ALEKOV_CONNECT_DEADLINE');
    if(found.reply)return found.reply;
    const f=found.flow,at=clock();
    if(closed)return failure(503,'ALEKOV_CONNECT_UNAVAILABLE');
    if(expired(deadline,signal))return failure(504,'ALEKOV_CONNECT_DEADLINE');
    if(flows.get(f.id)!==f)return failure(404,'ALEKOV_CONNECT_NOT_FOUND');
    found.acceptedAt=at;
    if(TERMINAL.has(f.state)&&now()-f.settledMono>=retainMs){flows.delete(f.id);return failure(404,'ALEKOV_CONNECT_NOT_FOUND');}
    if(!TERMINAL.has(f.state)&&now()>=f.deadline){settle(f,'unknown','ALEKOV_CONNECT_TIMEOUT',at);return null;}
    if(f.state==='awaiting_approval'&&at>=Date.parse(f.expiresAt))settle(f,'error','ALEKOV_CONNECT_EXPIRED',at);
    if(!found.scopeValid){
      if(f.state==='connected'){f.state='unknown';f.reason='ALEKOV_CONNECT_CONTEXT_CHANGED';f.settledAt=at;recordTerminal(f);}
      else settle(f,'unknown','ALEKOV_CONNECT_CONTEXT_CHANGED',at);
      return failure(409,'ALEKOV_CONNECT_CONTEXT_CHANGED');
    }
    return null;
  }

  async function start(input,{signal}={}){
    if(!exact(input,[]))return failure(400,'ALEKOV_CONNECT_INPUT_INVALID');if(closed)return failure(503,'ALEKOV_CONNECT_UNAVAILABLE');
    prune();if(!capacity(flows,starting,maxFlows))return failure(429,'ALEKOV_CONNECT_BUSY');starting++;
    const controller=new AbortController(),deadline=now()+startTimeoutMs;
    let cap,capDeadline,flow,timer;const stop=()=>controller.abort();pendingControllers.add(controller);
    if(signal?.aborted)stop();else signal?.addEventListener('abort',stop,{once:true});timer=setTimeout(stop,startTimeoutMs);
    const alive=()=>{if(closed||controller.signal.aborted||now()>=deadline)throw Error('ALEKOV_CONNECT_DEADLINE');};
    const stage=async work=>{alive();const value=await within(work,deadline,controller.signal);alive();if(late(value)||value===null)throw Error('ALEKOV_CONNECT_CONTEXT_UNVERIFIED');return value;};
    try{
      // A successful flow keeps its independent capability/controller for finish.
      // A late capability after close/timeout is released before it can be used.
      await stage(async()=>{capDeadline=now()+finishTimeoutMs;const opened=await openNativeHostOperation(host,{signal:controller.signal,timeoutMs:finishTimeoutMs});
        if(closed||controller.signal.aborted||now()>=deadline){closeNativeHostOperation(opened);throw Error('ALEKOV_CONNECT_DEADLINE');}
        // Own the acquired value before within/stage can discard a late result.
        cap=opened;return opened;});
      const context=await stage(()=>readNativeHostOperation(host,cap));alive();
      const vault=createNativeOperationVault(host,cap);
      const capabilityAlive=()=>{
        if(closed||controller.signal.aborted)throw own('ALEKOV_CONNECT_CANCELLED');
        if(now()>=Math.min(capDeadline,flow?capDeadline:deadline))throw own('ALEKOV_CONNECT_TIMEOUT');
        assertNativeHostOperation(host,cap);
        if(closed||controller.signal.aborted)throw own('ALEKOV_CONNECT_CANCELLED');
        if(now()>=Math.min(capDeadline,flow?capDeadline:deadline))throw own('ALEKOV_CONNECT_TIMEOUT');
      };
      const connector=createAlekovAppConnector({enabled:true,fetchImpl,clock,timeoutMs:finishTimeoutMs,pollIntervalMs,
        resolveCurrentContext:async()=>{
          capabilityAlive();const scopeDeadline=Math.min(capDeadline,flow?capDeadline:deadline),current=await within(()=>readNativeHostOperation(host,cap),scopeDeadline,controller.signal);
          capabilityAlive();if(!current||late(current))throw own('ALEKOV_CONNECT_CONTEXT_UNVERIFIED');return current;
        },
        persistCredential:async(input,call)=>{
          const active=()=>{if(!flow||flow.state!=='checking'||flow.controller!==controller)throw own('ALEKOV_CONNECT_CONTEXT_CHANGED');capabilityAlive();};
          active();const ack=await vault.persistCredential(input,call);active();const acknowledged=ack.persisted===true;active();flow.vaultAck=acknowledged;return ack;
        }});
      const result=await stage(()=>connector.begin({signal:controller.signal}));alive();assertNativeHostOperation(host,cap);
      if(!result?.ok||!result.connection||!isWorkbenchApprovalUrl(result.connection.approvalUrl,result.connection.deviceId,context.projectId)||flows.has(result.connection.deviceId))throw Error('ALEKOV_CONNECT_OUTCOME_UNKNOWN');
      alive();capabilityAlive();
      flow={id:result.connection.deviceId,expiresAt:result.connection.expiresAt,state:'awaiting_approval',reason:null,cap,controller,deadline:capDeadline,connector,handle:result.handle,vaultAck:false,timer:null};
      alive();capabilityAlive();alive();flows.set(flow.id,flow);
      // Native capability lifetime began at open, not at registration or finish.
      const ownsTimer=()=>flow.timer===flowTimer&&flow.controller===controller&&!TERMINAL.has(flow.state)&&flows.get(flow.id)===flow;
      const flowTimer=ownedDeadlineTimer(()=>{
        if(!ownsTimer()||closed)throw ABORTED;
        const left=remainingUntil(capDeadline,controller.signal);
        if(!ownsTimer()||closed)throw ABORTED;
        return left;
      },cause=>{if(ownsTimer())settle(flow,'unknown',cause===TIMEOUT?'ALEKOV_CONNECT_TIMEOUT':cause===ABORTED?'ALEKOV_CONNECT_CANCELLED':'ALEKOV_CONNECT_OUTCOME_UNKNOWN');});
      flow.timer=flowTimer;flowTimer.arm(Math.max(0,capDeadline-now()));
      return reply(201,{ok:true,data:{...view(flow),approvalUrl:result.connection.approvalUrl,confirmation:result.connection.confirmation}});
    }catch{controller.abort();closeNativeHostOperation(cap);return failure(closed?503:signal?.aborted||now()>=deadline?504:409,closed?'ALEKOV_CONNECT_UNAVAILABLE':signal?.aborted||now()>=deadline?'ALEKOV_CONNECT_DEADLINE':'ALEKOV_CONNECT_CONTEXT_UNVERIFIED');}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',stop);pendingControllers.delete(controller);starting--;}
  }

  async function finish(input,{signal}={}){
    const deadline=now()+5000,found=await locate(input,signal,deadline),rejected=accept(found,signal,deadline);if(rejected)return rejected;
    const f=found.flow;if(f.state!=='awaiting_approval')return reply(200,{ok:true,data:view(f)});
    if(expired(deadline,signal))return failure(504,'ALEKOV_CONNECT_DEADLINE');
    f.state='checking';
    const alive=()=>{
      if(f.state!=='checking')return false;
      if(now()>=f.deadline){settle(f,'unknown','ALEKOV_CONNECT_TIMEOUT');return false;}
      if(closed||f.controller.signal.aborted){settle(f,'unknown','ALEKOV_CONNECT_CANCELLED');return false;}
      return true;
    };
    const complete=(state,reason)=>{const at=terminalTimestamp(clock);if(alive())settle(f,state,reason,at);};
    const pending=(async()=>{
      if(!alive())return;
      const result=await f.connector.complete(f.handle,{signal:f.controller.signal});
      if(!alive())return;
      const current=await within(()=>readNativeHostOperation(host,f.cap),f.deadline,f.controller.signal);
      if(!alive())return;
      if(!current||late(current))return complete('unknown','ALEKOV_CONNECT_CONTEXT_CHANGED');
      assertNativeHostOperation(host,f.cap);
      if(result?.ok===true&&f.vaultAck)complete('connected');else complete('unknown','ALEKOV_CONNECT_OUTCOME_UNKNOWN');
    })();pending.catch(()=>complete('unknown','ALEKOV_CONNECT_CONTEXT_CHANGED'));
    return reply(202,{ok:true,data:view(f)});
  }
  async function status(input,{signal}={}){
    const deadline=now()+5000,found=await locate(input,signal,deadline),rejected=accept(found,signal,deadline);if(rejected)return rejected;
    return reply(200,{ok:true,data:view(found.flow)});
  }
  async function cancel(input,{signal}={}){
    const deadline=now()+5000,found=await locate(input,signal,deadline),rejected=accept(found,signal,deadline);if(rejected)return rejected;
    settle(found.flow,found.flow.state==='checking'?'unknown':'cancelled','ALEKOV_CONNECT_CANCELLED',found.acceptedAt);return reply(200,{ok:true,data:view(found.flow)});
  }
  return Object.freeze({get available(){return !closed;},start,finish,status,cancel,close(){if(closed)return;closed=true;for(const c of pendingControllers)c.abort();pendingControllers.clear();for(const f of flows.values())settle(f,'unknown','ALEKOV_CONNECT_CANCELLED');flows.clear();}});
}
