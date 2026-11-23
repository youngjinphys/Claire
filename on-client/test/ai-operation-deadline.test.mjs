import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {createOnAiService} from '../src/ai/service.mjs';
import {prepareLearnerSupportRequest,renderLearnerSupportModelResult} from '../src/ai/learner-support-contract.mjs';

const BUDGET=100;
const block=()=>{const until=performance.now()+160;while(performance.now()<until){}};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const incident={incidentId:'incident',evidence:[{id:'evidence',summary:'Synthetic fixture evidence'}],rules:[{id:'rule',description:'Synthetic fixture rule'}],
  currentState:{access:'allowed',session:'active',device:'compliant'},supportedActions:['device:revoke']};
const explanation={summary:'The supplied evidence requires human review.',evidenceIds:['evidence'],proposals:[]};
const supportInput={problemKind:'app-start'},observation={engine:{mode:'disconnected',code:'ENGINE_NOT_CONNECTED'},ai:{configured:true,authorized:false}};
function fixture(kind,{timeoutMs=BUDGET}={}){
  // These credentials and transport/verifier responses are synthetic fixtures.
  // No test uses global fetch, a live gateway, or a real AI provider.
  const token='sk-on-'+'a'.repeat(43),fingerprint=createHash('sha256').update(token).digest('hex');
  const scope={subjectId:'student',projectId:'fixture-project',appId:'aleph-on',audience:'on-client'},context={alephUserId:'aleph-user',siteId:'site',identityVersion:1};
  const simple=kind.endsWith('-basic'),hooks={},calls={};
  const invoke=async(name,fallback,...args)=>{calls[name]=(calls[name]??0)+1;return hooks[name]?hooks[name](fallback,...args):fallback(...args);};
  const rawProof=purpose=>({...scope,...context,credentialId:'credential',grantId:'grant',grantVersion:1,policyVersion:'policy-v1',accessPolicyId:'access-policy',
    purpose,requiredCapability:purpose==='models'?'ai.models':'ai.explain',capabilities:['ai.models','ai.explain'],validUntil:new Date(Date.now()+60000).toISOString(),revoked:false,
    credentialFingerprint:fingerprint,allowedModels:['fixture-model'],modelPolicyVersion:'policy-v1'});
  const syntheticProof=options=>({...rawProof(options.purpose),mode:'test',appKeyScope:structuredClone(scope)});
  const prepared=prepareLearnerSupportRequest(supportInput,observation),payload=JSON.parse(prepared.messages[1].content),selected=payload.candidates[0];
  const guide=renderLearnerSupportModelResult(prepared,JSON.stringify({hypothesisId:selected.hypothesisId,evidenceIds:selected.evidenceIds,actionIds:[payload.actions[0].actionId,'contact-instructor']}));
  const client={
    listModels:(...args)=>invoke('listModels',()=>[{id:'fixture-model'}],...args),
    chat:(...args)=>invoke('chat',()=>({choices:[{message:{content:JSON.stringify(explanation)}}]}),...args),
    learnerSupport:(...args)=>invoke('learnerSupport',()=>({ok:true,data:guide}),...args),
  };
  const baseUrl=simple?'http://127.0.0.1:9999/api/apps/aleph-on/v1':'https://fixture.invalid/api/apps/aleph-on/v1';
  const service=createOnAiService({env:{ON_AI_BASE_URL:baseUrl,ON_AI_APP_KEY:token,ON_AI_MODEL:'fixture-model'},allowLoopbackHttp:simple,timeoutMs,
    ...(simple?{verifyAppAuthorization:options=>invoke('authorization',syntheticProof,options)}:
      {appAuthorization:{fetchImpl:(url,options)=>invoke('authorization',()=>Response.json(rawProof(new URL(url).searchParams.get('purpose'))),url,options)}}),
    transportFactory:(...args)=>{calls.factory=(calls.factory??0)+1;return hooks.factory?hooks.factory(()=>client,...args):client;}});
  const options={expectedScope:structuredClone(scope),expectedContext:structuredClone(context)};
  if(!simple){options.beforeDispatch=(...args)=>invoke('beforeDispatch',()=>{},...args);options.beforePublish=(...args)=>invoke('beforePublish',()=>{},...args);}
  const run=(override=options)=>kind.startsWith('models')?service.checkConnection(override):kind.startsWith('incident')?service.explainIncident(incident,override):service.explainLearningSupport(supportInput,observation,override);
  const method=kind.startsWith('models')?'listModels':kind.startsWith('incident')?'chat':'learnerSupport';
  return {service,hooks,calls,client,options,run,method,syntheticProof};
}
const late=(fallback,...args)=>{block();return fallback(...args);};
const expired=result=>{assert.equal(result.ok,false);assert.equal(result.error.code,'WB_CLCO_TIMEOUT');assert.equal(result.transportChecked,undefined);};

for(const kind of ['models-basic','incident-basic']){
  test(`${kind}: a verifier that blocks past the deadline cannot initialize or dispatch transport`,async()=>{
    const f=fixture(kind);f.hooks.authorization=late;expired(await f.run());
    assert.equal(f.calls.authorization,1);assert.equal(f.calls.factory??0,0);assert.equal(f.calls[f.method]??0,0);
  });
  test(`${kind}: transport initialization cannot dispatch after consuming the deadline`,async()=>{
    const f=fixture(kind);f.hooks.factory=late;expired(await f.run());
    assert.equal(f.calls.factory,1);assert.equal(f.calls[f.method]??0,0);
  });
  test(`${kind}: a delayed transport result cannot publish success`,async()=>{
    const f=fixture(kind);f.hooks[f.method]=late;expired(await f.run());assert.equal(f.calls[f.method],1);
  });
  test(`${kind}: late verifier completion after the race ends cannot start a later stage`,{timeout:3000},async()=>{
    const f=fixture(kind),gate=deferred();let proof;
    f.hooks.authorization=(fallback,...args)=>{proof=fallback(...args);return gate.promise;};
    expired(await f.run());gate.resolve(proof);await turn();assert.equal(f.calls.factory??0,0);assert.equal(f.calls[f.method]??0,0);
  });
}
test('late asynchronous transport initialization cannot send a model request', {timeout:3000},async()=>{
  const f=fixture('models-basic'),gate=deferred();f.hooks.factory=()=>gate.promise;
  expired(await f.run());gate.resolve(f.client);await turn();assert.equal(f.calls.listModels??0,0);assert.equal(f.calls.factory,1);
});
test('incident output processing is checked again before publishing a successful explanation',async()=>{
  const f=fixture('incident-basic');
  f.hooks.chat=()=>({choices:[{message:{get content(){block();return JSON.stringify(explanation);}}}]});
  expired(await f.run());assert.equal(f.calls.chat,1);
});
for(const kind of ['models-guarded','incident-guarded','support']){
  test(`${kind}: beforeDispatch expiry prevents transport while retaining the original authority checks`,async()=>{
    const f=fixture(kind);f.hooks.beforeDispatch=late;expired(await f.run());
    assert.equal(f.calls.beforeDispatch,1);assert.equal(f.calls[f.method]??0,0);assert.equal(f.calls.beforePublish??0,0);
  });
  test(`${kind}: beforePublish expiry prevents publication without retrying the completed request`,async()=>{
    const f=fixture(kind);f.hooks.beforePublish=late;expired(await f.run());
    assert.equal(f.calls.beforeDispatch,1);assert.equal(f.calls[f.method],1);assert.equal(f.calls.beforePublish,1);
    if(kind==='support')assert.equal(f.calls.authorization,1,'An expired publish callback cannot start another authorization request');
  });
  test(`${kind}: a timed-out transport cannot invoke the publish callback`,async()=>{
    const f=fixture(kind);f.hooks[f.method]=late;expired(await f.run());
    assert.equal(f.calls[f.method],1);assert.equal(f.calls.beforePublish??0,0);
  });
  test(`${kind}: timely authority-bound work still succeeds with both callbacks`,async()=>{
    const f=fixture(kind,{timeoutMs:2000}),result=await f.run();
    assert.equal(result.ok,true);assert.equal(result.audienceAuthorization,'verified');assert.equal(f.calls.beforeDispatch,1);assert.equal(f.calls.beforePublish,1);assert.equal(f.calls[f.method],1);
    assert.ok(result.authorizationValidUntilMs>Date.now());
    if(kind==='support'){assert.equal(result.guide.executed,false);assert.equal(result.guide.source,'gpt-guide');}
  });
}
test('learner support options retain proxy/accessor rejection without executing traps or authorizing',async()=>{
  for(const variant of ['options-proxy','options-getter','callback-proxy','signal-proxy']){
    const f=fixture('support');let touched=0,options={...f.options};
    if(variant==='options-proxy')options=new Proxy(options,{ownKeys(){touched++;throw Error('must not inspect');}});
    if(variant==='options-getter')Object.defineProperty(options,'expectedScope',{enumerable:true,get(){touched++;throw Error('must not invoke');}});
    if(variant==='callback-proxy')options.beforeDispatch=new Proxy(()=>{},{apply(){touched++;throw Error('must not call');}});
    if(variant==='signal-proxy')options.signal=new Proxy(new AbortController().signal,{get(){touched++;throw Error('must not inspect');}});
    const result=await f.run(options);assert.equal(result.error.code,'LEARNER_SUPPORT_INPUT_INVALID',variant);assert.equal(touched,0);assert.equal(f.calls.authorization??0,0);
  }
});
test('learner support transport methods retain descriptor-only validation',async()=>{
  const f=fixture('support');let getters=0;
  Object.defineProperty(f.client,'learnerSupport',{get(){getters++;return ()=>{throw Error('must not dispatch');};}});
  const result=await f.run();assert.equal(result.error.code,'ON_AI_TRANSPORT_PENDING');assert.equal(getters,0);assert.equal(f.calls.beforeDispatch??0,0);
});
test('learner support callback failure retains provisioning failure and does not dispatch',async()=>{
  const f=fixture('support');f.hooks.beforeDispatch=()=>{throw Error('host context changed');};
  const result=await f.run();assert.equal(result.error.code,'ON_AI_PROVISIONING_PENDING');assert.equal(f.calls.learnerSupport??0,0);
});
test('pre-cancelled AI calls retain cancellation and perform no authorization or transport work',async()=>{
  for(const kind of ['models-basic','incident-basic','support']){
    const f=fixture(kind),controller=new AbortController();controller.abort();
    const result=await f.run({...f.options,signal:controller.signal});assert.equal(result.error.code,'WB_CLCO_CANCELLED');assert.equal(f.calls.authorization??0,0);assert.equal(f.calls.factory??0,0);
  }
});
