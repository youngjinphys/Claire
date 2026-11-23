import {createResponseLifetime} from '../../public/http-response.mjs';
import {ownedDeadlineTimer} from '../../public/deadline-timer.mjs';
// 서버 전용 native 로그인. 원격 handle/verifier와 세대는 공개 DTO에 포함하지 않는다.
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {types} from 'node:util';
import {ALEPH_PORTAL_ORIGIN,CLCO_GATEWAY_ORIGIN} from '../ai/connection.mjs';

const producers=new WeakMap(),operations=new WeakMap();
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const CANONICAL=['canonicalStudentId','alephUserId','siteId','identityVersion'];
const CODES=new Set(['INPUT_INVALID','DISABLED','CANCELLED','EXPIRED','TIMEOUT','RESPONSE_INVALID','CONTEXT_CHANGED','UNVERIFIED','OUTCOME_UNKNOWN','BUSY']);
export const nativeFault=code=>Object.assign(new Error('NATIVE_HOST_'+code),{code:'NATIVE_HOST_'+code});
export function nativeOwn(value,keys,optional=[]){
  if(!value||typeof value!=='object'||types.isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw nativeFault('INPUT_INVALID');
  const descriptors=Object.getOwnPropertyDescriptors(value),names=Reflect.ownKeys(descriptors);
  if(names.some(k=>typeof k!=='string'||!keys.includes(k)&&!optional.includes(k))||keys.some(k=>!Object.hasOwn(descriptors,k)))throw nativeFault('INPUT_INVALID');
  const result={};for(const k of names){const d=descriptors[k];if(!Object.hasOwn(d,'value')||!d.enumerable)throw nativeFault('INPUT_INVALID');result[k]=d.value;}return Object.freeze(result);
}
export function nativeSignal(value){if(value!==undefined&&(types.isProxy(value)||Object.getPrototypeOf(value)!==AbortSignal.prototype||['aborted','addEventListener','removeEventListener'].some(k=>Object.getOwnPropertyDescriptor(value,k))))throw nativeFault('INPUT_INVALID');return value;}
const hash=s=>createHash('sha256').update(s).digest('base64url');
function canonical(value){const c=nativeOwn(value,CANONICAL);if(!Number.isSafeInteger(c.identityVersion)||c.identityVersion<1||CANONICAL.slice(0,3).some(k=>typeof c[k]!=='string'||!c[k]||c[k].length>200||/[\x00-\x1f\x7f]/.test(c[k])))throw nativeFault('RESPONSE_INVALID');return c;}
const same=(a,b)=>CANONICAL.every(k=>a[k]===b[k]);
export function nativePublicError(error){const d=error&&typeof error==='object'&&!types.isProxy(error)?Object.getOwnPropertyDescriptor(error,'code'):null;
  const code=d&&Object.hasOwn(d,'value')&&typeof d.value==='string'&&d.value.startsWith('NATIVE_HOST_')?d.value.slice(12):'';
  return CODES.has(code)?'NATIVE_HOST_'+code:'NATIVE_HOST_UNVERIFIED';}

export function createNativeLogin(options={}){
  const o=nativeOwn(options,[],['enabled','gatewayOrigin','portalOrigin','fetchImpl','clock','timeoutMs']);
  const enabled=o.enabled===true,gateway=o.gatewayOrigin??CLCO_GATEWAY_ORIGIN,portal=o.portalOrigin??ALEPH_PORTAL_ORIGIN;
  const fetchImpl=o.fetchImpl??globalThis.fetch,clock=o.clock??Date.now,timeout=o.timeoutMs??10000;
  if(o.enabled!==undefined&&typeof o.enabled!=='boolean'||gateway!==CLCO_GATEWAY_ORIGIN||portal!==ALEPH_PORTAL_ORIGIN||typeof fetchImpl!=='function'||types.isProxy(fetchImpl)||typeof clock!=='function'||types.isProxy(clock)||!Number.isSafeInteger(timeout)||timeout<1||timeout>15000)throw nativeFault('INPUT_INVALID');
  const s={enabled,generation:0,state:'disconnected',session:null,ticket:null,cancellation:null,closed:false,requests:new Set(),operations:new Set()};
  // backend nonce는 session revision에 묶인다. 동일 producer의 current/cancel 교환을 순서대로 끝낸다.
  // 각 호출은 자기 generation/signal을 유지하며 충돌 응답을 자동 재시도하지 않는다.
  let currentTail=Promise.resolve();
  function serializedCurrent(work,g,signal,limit){
    let listening=false,waiting=true,retired=false,waitError,rejectWait;
    const interrupted=new Promise((_,reject)=>{rejectWait=reject;});
    const dispose=()=>{timer.dispose();
      if(listening){listening=false;signal.removeEventListener('abort',onAbort);}};
    const fail=error=>{if(!waiting)return;waiting=false;retired=true;waitError=error;dispose();rejectWait(error);};
    const onAbort=()=>{try{active(g,signal,limit);}catch(error){fail(error);}};
    const timer=ownedDeadlineTimer(()=>{const {at,mono}=budgetSample(g,signal,limit);return Math.min(limit.wall-at,limit.mono-mono);},fail);
    try{
      const {at,mono}=budgetSample(g,signal,limit);
      if(signal){listening=true;signal.addEventListener('abort',onAbort,{once:true});if(signal.aborted)onAbort();}
      if(waiting&&limit){const remaining=Math.min(limit.wall-at,limit.mono-mono);
        if(remaining<=0)fail(nativeFault(limit.code??'TIMEOUT'));else timer.arm(remaining);}
    }catch(error){fail(error);}
    // Only the caller races its queue wait. The actual work keeps the revision
    // chain occupied, and a retired entry cannot run when that chain resumes.
    const result=currentTail.then(()=>{if(retired)throw waitError;waiting=false;dispose();return work();});
    currentTail=result.catch(()=>{});return Promise.race([result,interrupted]).finally(dispose);
  }
  const time=()=>{const at=clock();if(!Number.isSafeInteger(at)||at<=0)throw nativeFault('UNVERIFIED');return at;};
  function invalidate(){
    const g=++s.generation,requests=[...s.requests],open=[...s.operations];s.session=null;
    // Abort callbacks can reenter this producer. Close only this generation's
    // captured work, and never adopt a generation opened by those callbacks.
    for(const c of requests)c.abort();for(const op of open)op.close();return g;
  }
  const abortCode=(signal,limit)=>limit?.expiryReason&&signal.reason===limit.expiryReason?'EXPIRED':'CANCELLED';
  function active(g,signal,limit){if(!enabled||s.closed)throw nativeFault('DISABLED');if(g!==s.generation)throw nativeFault('CONTEXT_CHANGED');if(signal?.aborted)throw nativeFault(abortCode(signal,limit));}
  // Dependent exchanges retain their caller's absolute ceiling, including time
  // spent waiting in the revision queue. A request never renews that budget.
  function checkBudget(limit,at,mono){if(limit&&(at>=limit.wall||mono>=limit.mono))throw nativeFault(limit.code??'TIMEOUT');}
  function budgetSample(g,signal,limit){active(g,signal,limit);const at=time(),mono=performance.now();active(g,signal,limit);
    checkBudget(limit,at,mono);return {at,mono};}
  const budgetTime=(g,signal,limit)=>budgetSample(g,signal,limit).at;
  async function request(kind,body,g,signal,prefix='/api/apps/aleph-on/native-login/',limit){
    active(g,signal,limit);const started=performance.now(),mono=Math.min(started+timeout,limit?.mono??Infinity),at=budgetTime(g,signal,limit),deadline=Math.min(at+timeout,limit?.wall??Infinity);
    active(g,signal,limit);const now=performance.now(),ownRemaining=Math.min(timeout,started+timeout-now),outerRemaining=limit?Math.min(limit.wall-at,limit.mono-now):Infinity;
    const remaining=Math.min(ownRemaining,outerRemaining),timeoutCode=outerRemaining<=ownRemaining?limit?.code??'TIMEOUT':'TIMEOUT';if(remaining<=0)throw nativeFault(timeoutCode);
    const controller=new AbortController(),lifetime=createResponseLifetime(controller.signal),stop=()=>controller.abort();
    let timerFailed=false,timerError;
    // Invalidation aborts requests before operations; retain the current owner cause.
    const abortFailure=()=>{try{active(g,signal,limit);}catch(error){return error;}
      return timerFailed?timerError:nativeFault(timeoutCode);};
    const alive=()=>{const sampled=budgetSample(g,signal,limit);
      if(sampled.at>=deadline||sampled.mono>=mono)throw nativeFault('TIMEOUT');
      if(controller.signal.aborted)throw abortFailure();active(g,signal,limit);return sampled;};
    const timer=ownedDeadlineTimer(()=>{const sampled=alive();return Math.min(deadline-sampled.at,mono-sampled.mono);},error=>{timerFailed=true;timerError=error;controller.abort();});
    if(signal?.aborted)stop();else signal?.addEventListener('abort',stop,{once:true});s.requests.add(controller);
    let rejectAbort;const aborted=new Promise((_,reject)=>{rejectAbort=()=>reject(abortFailure());controller.signal.addEventListener('abort',rejectAbort,{once:true});});aborted.catch(()=>{});
    try{
      timer.arm(remaining);
      const work=(async()=>{alive();const r=lifetime.response(await fetchImpl(gateway+prefix+kind,{method:'POST',redirect:'manual',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:controller.signal}));alive();
        if(r.redirected||r.status>=300&&r.status<400||!/^application\/json(?:;|$)/i.test(r.headers.get('content-type')??''))throw nativeFault('RESPONSE_INVALID');
        const declared=r.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>8192))throw nativeFault('RESPONSE_INVALID');
        const reader=r.body?.getReader ? lifetime.reader(r.body.getReader()) : null;if(!reader)throw nativeFault('RESPONSE_INVALID');let size=0,chunks=[];
        try{while(true){const p=await reader.read();alive();if(p.done)break;size+=p.value.byteLength;if(size>8192)throw nativeFault('RESPONSE_INVALID');chunks.push(Buffer.from(p.value));}}finally{lifetime.close();}
        let parsed;try{parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw nativeFault('RESPONSE_INVALID');}
        alive();if(r.status!==200&&r.status!==201&&r.status!==202)throw nativeFault(r.status===410?'EXPIRED':r.status===409?'CONTEXT_CHANGED':'UNVERIFIED');
        const envelope=nativeOwn(parsed,['ok','data']);if(envelope.ok!==true)throw nativeFault('RESPONSE_INVALID');return {status:r.status,data:envelope.data};})();work.catch(()=>{});
      const result=await Promise.race([work,aborted]);alive();return result;
    }finally{timer.dispose();signal?.removeEventListener('abort',stop);controller.signal.removeEventListener('abort',rejectAbort);s.requests.delete(controller);controller.abort();lifetime.close();}
  }
  function captureSession(raw,previous,limit){const d=nativeOwn(raw,[...CANONICAL,'nativeSessionId','expiresAtMs','proofUntilMs']),c=canonical(Object.fromEntries(CANONICAL.map(k=>[k,d[k]]))),started=performance.now(),at=time();
    if(!UUID.test(d.nativeSessionId)||!Number.isSafeInteger(d.expiresAtMs)||!Number.isSafeInteger(d.proofUntilMs)||d.proofUntilMs<=at||d.proofUntilMs>d.expiresAtMs||previous&&(!same(c,previous.canonical)||previous.instance!==d.nativeSessionId||previous.expires!==d.expiresAtMs))throw nativeFault('CONTEXT_CHANGED');
    const mono=started+Math.min(d.expiresAtMs,d.proofUntilMs)-at,completed=performance.now();checkBudget(limit,at,completed);if(completed>=mono)throw nativeFault('EXPIRED');
    return {canonical:c,instance:d.nativeSessionId,expires:d.expiresAtMs,proof:d.proofUntilMs,mono};
  }
  function refresh(g,signal,limit){active(g,signal,limit);return serializedCurrent(()=>refreshCurrent(g,signal,limit),g,signal,limit);}
  async function refreshCurrent(g,signal,limit){active(g,signal,limit);const old=s.session;if(!old)throw nativeFault('UNVERIFIED');
    const bound=limit?{...limit,wall:Math.min(limit.wall,old.expires)}:undefined;
    if(budgetTime(g,signal,bound)>=old.expires)throw nativeFault('EXPIRED');const n=await request('nonce',{handle:old.handle,verifier:old.verifier,action:'current'},g,signal,undefined,bound);
    const v=nativeOwn(n.data,['nonce','expiresAtMs']);if(typeof v.nonce!=='string'||!Number.isSafeInteger(v.expiresAtMs)||v.expiresAtMs<=budgetTime(g,signal,bound))throw nativeFault('RESPONSE_INVALID');
    const response=await request('current',{handle:old.handle,verifier:old.verifier,nonce:v.nonce},g,signal,undefined,bound);const fresh=captureSession(response.data,old,bound);active(g,signal,bound);
    s.session={...old,...fresh};s.state='connected';return s.session;
  }
  const publicView=()=>Object.freeze({state:s.state,expiresAtMs:s.session?.expires??s.ticket?.expires??null,approvalUrl:s.ticket?.url??null,confirmation:s.ticket?.confirmation??null});
  const api=Object.freeze({
    async start(input={},call={}){nativeOwn(input,[]);const {signal}=nativeOwn(call,[],['signal']);nativeSignal(signal);if(!enabled||s.closed)throw nativeFault('DISABLED');
      // 이전 verifier를 새 로그인에 사용하지 않는다. 미확정 원격 ticket은 자동 재발급하지 않는다.
      if(s.ticket||s.cancellation)throw nativeFault('BUSY');s.state='starting';const g=invalidate();
      try{active(g,signal);const verifier=randomBytes(32).toString('base64url'),deviceId=randomUUID(),challenge=hash(verifier);
        s.ticket={deviceId,verifier,challenge,expires:null,url:null,confirmation:null};
        const r=await request('start',{deviceId,challenge},g,signal),d=nativeOwn(r.data,['deviceId','challenge','confirmation','approvalUrl','expiresAtMs','state']);
        const u=new URL(d.approvalUrl);if(d.deviceId!==deviceId||d.challenge!==challenge||d.state!=='pending'||typeof d.confirmation!=='string'||!/^\d{6}$/.test(d.confirmation)||!Number.isSafeInteger(d.expiresAtMs)||d.expiresAtMs<=time()||u.origin!==portal||u.pathname!=='/workbench.html'||u.hash||u.username||u.password||[...u.searchParams.keys()].join(',')!=='nativeLogin,device,challenge'||u.searchParams.get('nativeLogin')!=='alekov'||u.searchParams.get('device')!==deviceId||u.searchParams.get('challenge')!==challenge||u.href!==d.approvalUrl)throw nativeFault('RESPONSE_INVALID');
        active(g,signal);s.ticket={...s.ticket,expires:d.expiresAtMs,url:d.approvalUrl,confirmation:d.confirmation};s.state='awaiting_approval';return publicView();
      }catch(e){if(g===s.generation)s.state='unknown';throw e;}
    },
    async redeem(input={},call={}){nativeOwn(input,[]);const {signal}=nativeOwn(call,[],['signal']);nativeSignal(signal);const g=s.generation,t=s.ticket;active(g,signal);if(s.cancellation)throw nativeFault('BUSY');if(!t||!t.expires)throw nativeFault('UNVERIFIED');if(time()>=t.expires)throw nativeFault('EXPIRED');
      try{const r=await request('redeem',{deviceId:t.deviceId,verifier:t.verifier},g,signal);if(r.status===202){const d=nativeOwn(r.data,['state']);if(d.state!=='pending')throw nativeFault('RESPONSE_INVALID');return publicView();}
        const d=nativeOwn(r.data,[...CANONICAL,'nativeSessionId','expiresAtMs','proofUntilMs','handle']);if(typeof d.handle!=='string'||!/^nl1_[A-Za-z0-9_-]{43}$/.test(d.handle))throw nativeFault('RESPONSE_INVALID');
        const session=captureSession(Object.fromEntries([...CANONICAL,'nativeSessionId','expiresAtMs','proofUntilMs'].map(k=>[k,d[k]])));active(g,signal);s.session={...session,handle:d.handle,verifier:t.verifier};s.ticket=null;s.state='connected';return publicView();
      }catch(e){if(g===s.generation)s.state='unknown';throw e;}
    },
    async current(input={},call={}){nativeOwn(input,[]);const {signal}=nativeOwn(call,[],['signal']);nativeSignal(signal);await refresh(s.generation,signal);return publicView();},
    status(input={}){nativeOwn(input,[]);if(!enabled||s.closed)throw nativeFault('DISABLED');return publicView();},
    async cancel(input={},call={}){nativeOwn(input,[]);const {signal}=nativeOwn(call,[],['signal']);nativeSignal(signal);if(!enabled||s.closed)throw nativeFault('DISABLED');
      const entry=s.generation,mono=performance.now()+timeout,wall=time()+timeout;active(entry);
      // One private retry target survives only until acknowledgment or close.
      // It never supplies session authority; local expiry is not a cancel ack.
      const old=s.session,t=s.ticket,target=s.cancellation??(t?Object.freeze({kind:'ticket',deviceId:t.deviceId,verifier:t.verifier})
        :old?Object.freeze({kind:'session',handle:old.handle,verifier:old.verifier}):null);
      s.cancellation=target;s.ticket=null;s.state=target?'unknown':'cancelled';const g=invalidate(),limit={wall,mono};
      const check=()=>{active(g,signal);if(time()>=wall||performance.now()>=mono)throw nativeFault('TIMEOUT');active(g,signal);if(s.cancellation!==target)throw nativeFault('CONTEXT_CHANGED');};
      try{
        const result=await serializedCurrent(async()=>{check();if(!target)return null;
          if(target.kind==='ticket')return request('cancel',{deviceId:target.deviceId,verifier:target.verifier},g,signal,undefined,limit);
          const n=await request('nonce',{handle:target.handle,verifier:target.verifier,action:'cancel'},g,signal,undefined,limit);
          const d=nativeOwn(n.data,['nonce','expiresAtMs']);
          // Match the native-login current nonce contract; receipt nonces have
          // a separate, stricter format and do not define this route's schema.
          if(typeof d.nonce!=='string'||!Number.isSafeInteger(d.expiresAtMs)||d.expiresAtMs<=time())throw nativeFault('RESPONSE_INVALID');
          check();return request('cancel',{handle:target.handle,verifier:target.verifier,nonce:d.nonce},g,signal,undefined,limit);
        },g,signal,limit);
        check();if(target&&result.status!==200)throw nativeFault('OUTCOME_UNKNOWN');
        s.cancellation=null;s.state='cancelled';return publicView();
      }
      catch(e){if(g===s.generation)s.state='unknown';throw e;}
    },
    close(){s.closed=true;s.state='cancelled';s.ticket=null;s.cancellation=null;invalidate();}
  });
  // c1(#968) genuine host 전용 receipt ticket: 같은 closure 의 handle/verifier 로 gateway native-receipt 경로(nonce → issue)를 부른다.
  // 브라우저 native-login ROUTES 가 아니며 handle/verifier·nonce 는 밖으로 내지 않는다. current/cancel 과 같은 순서 큐로 session revision 경합을 막는다.
  async function receiptTicket(g,signal,{challengeId,contextDigest},limit){
    return serializedCurrent(async()=>{active(g,signal,limit);const old=s.session;if(!old)throw nativeFault('UNVERIFIED');if(budgetTime(g,signal,limit)>=old.expires)throw nativeFault('EXPIRED');
      const prefix='/api/apps/aleph-on/native-receipt/';
      const n=nativeOwn((await request('nonce',{handle:old.handle,verifier:old.verifier},g,signal,prefix,limit)).data,['nonce','expiresAtMs']);
      if(typeof n.nonce!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(n.nonce)||!Number.isSafeInteger(n.expiresAtMs)||n.expiresAtMs<=budgetTime(g,signal,limit))throw nativeFault('RESPONSE_INVALID');
      const t=nativeOwn((await request('issue',{handle:old.handle,verifier:old.verifier,nonce:n.nonce,challengeId,contextDigest},g,signal,prefix,limit)).data,['ticket','challengeId','contextDigest','expiresAtMs']);
      active(g,signal,limit);if(s.session!==old)throw nativeFault('CONTEXT_CHANGED');
      if(typeof t.ticket!=='string'||!/^nrp1_[A-Za-z0-9_-]{43}$/.test(t.ticket)||t.challengeId!==challengeId||t.contextDigest!==contextDigest||!Number.isSafeInteger(t.expiresAtMs)||t.expiresAtMs<=budgetTime(g,signal,limit))throw nativeFault('RESPONSE_INVALID');
      active(g,signal,limit);if(s.session!==old)throw nativeFault('CONTEXT_CHANGED');
      return Object.freeze({ticket:t.ticket,expiresAtMs:t.expiresAtMs});},g,signal,limit);
  }
  producers.set(api,{s,refresh,active,time,receiptTicket});return api;
}

function operationLimit(op,requireProof=false){return Object.freeze({
  wall:Math.min(op.deadline,op.session?.expires??Infinity,requireProof?op.session.proof:Infinity),
  mono:Math.min(op.mono,requireProof?op.session.mono:Infinity),code:'EXPIRED',expiryReason:op.expiryReason});}

/** c1: 열린 native operation 으로만 receipt ticket 을 받는다. 앞뒤로 operation 수명·proof 를 확인한다. */
export async function issueNativeReceiptTicket(cap,input){
  const x=nativeOwn(input,['challengeId','contextDigest']);
  if(typeof x.challengeId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x.challengeId)
    ||typeof x.contextDigest!=='string'||!/^[0-9a-f]{64}$/.test(x.contextDigest))throw nativeFault('INPUT_INVALID');
  const op=operationLifetime(cap);assertNativeOperation(cap);
  const ticket=await op.p.receiptTicket(op.g,op.controller.signal,{challengeId:x.challengeId,contextDigest:x.contextDigest},operationLimit(op,true));
  assertNativeOperation(cap);return ticket;
}

export async function openNativeOperation(producer,call={}){
  const {signal,timeoutMs=10000}=nativeOwn(call,[],['signal','timeoutMs']);
  const p=producers.get(producer);if(!p)throw nativeFault('UNVERIFIED');nativeSignal(signal);if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>420000)throw nativeFault('INPUT_INVALID');
  const g=p.s.generation,mono=performance.now()+timeoutMs,controller=new AbortController(),stop=()=>controller.abort(),cap=Object.freeze(Object.create(null)),expiryReason=nativeFault('EXPIRED');let timer;
  const op={p,g,controller,deadline:0,mono,expiryReason,session:null,closed:false,close(){if(op.closed)return;op.closed=true;timer?.dispose();signal?.removeEventListener('abort',stop);controller.abort();p.s.operations.delete(op);}};
  // Own partial acquisition before the clock can throw or reenter close/invalidate.
  operations.set(cap,op);p.s.operations.add(op);
  try{
    if(signal?.aborted)stop();else signal?.addEventListener('abort',stop,{once:true});
    timer=ownedDeadlineTimer(()=>{const remaining=mono-performance.now();if(remaining<=0)throw expiryReason;return remaining;},()=>controller.abort(expiryReason));
    timer.arm(Math.max(0,mono-performance.now()));op.deadline=p.time()+timeoutMs;
    p.active(g,controller.signal,operationLimit(op));if(performance.now()>=mono)throw nativeFault('EXPIRED');
    op.session=await p.refresh(g,controller.signal,operationLimit(op));assertNativeOperation(cap);return cap;
  }catch(e){op.close();throw e;}
}
function operationLifetime(cap,requireProof=false){const op=operations.get(cap);if(!op||op.closed)throw nativeFault('UNVERIFIED');op.p.active(op.g,op.controller.signal,operationLimit(op));
  const at=op.p.time(),mono=performance.now();
  // The clock can close, abort or replace this operation synchronously.
  if(op.closed)throw nativeFault('UNVERIFIED');op.p.active(op.g,op.controller.signal,operationLimit(op));
  if(at>=op.deadline||mono>=op.mono||at>=op.session.expires||requireProof&&(at>=op.session.proof||mono>=op.session.mono))throw nativeFault('EXPIRED');return op;}
export function assertNativeOperation(cap){const op=operationLifetime(cap,true);return Object.freeze({...op.session.canonical});}
export async function refreshNativeOperation(cap){const op=operationLifetime(cap);const fresh=await op.p.refresh(op.g,op.controller.signal,operationLimit(op));
  if(fresh.instance!==op.session.instance||!same(fresh.canonical,op.session.canonical)||fresh.expires!==op.session.expires)throw nativeFault('CONTEXT_CHANGED');op.session=fresh;return assertNativeOperation(cap);}
export function nativeOperationBinding(cap){const op=operationLifetime(cap);return Object.freeze({canonical:op.session.canonical,nativeInstance:op.session.instance,generation:op.g,deadline:Math.min(op.deadline,op.session.expires),signal:op.controller.signal});}
export function closeNativeOperation(cap){operations.get(cap)?.close();}
