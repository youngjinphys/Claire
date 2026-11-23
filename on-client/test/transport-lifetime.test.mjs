import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createFetchTransport,createNativeFetchTransport,createNativeDeadline} from '../public/ai-connect.mjs';
import {createAlekovAppConnector} from '../src/ai/connection.mjs';
import {createNativeLogin} from '../src/connection/native-login.mjs';
import {createOnAppAuthorizationVerifier} from '../src/ai/app-authorization.mjs';
import {createOsvClient} from '../src/vulnerabilities/osv.mjs';
import {createClcoClient} from '../vendor/clco-http.mjs';

const turn=()=>new Promise(resolve=>setImmediate(resolve));

for(const elapsed of [0,36,37,38])test(`native browser deadline includes ${elapsed}ms of initial clock work`,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let mono=0,first=true,fetches=0;
  const deadline=createNativeDeadline(37,{monotonic:()=>mono,clock:()=>{if(first){first=false;mono+=elapsed;}return 100000;}});
  assert.equal(deadline.left(),37-elapsed);
  const result=await createNativeFetchTransport({fetchImpl:async()=>{
    fetches++;return Response.json({ok:true,data:{state:'disconnected',expiresAtMs:null,approvalUrl:null,confirmation:null}});
  }})('status',{deadline});
  assert.equal(fetches,elapsed<37?1:0);
  if(elapsed<37)assert.equal(result.ok,true);
  else assert.equal(result.error.code,'NATIVE_LOGIN_CLIENT_TIMEOUT');
});
const context={subjectId:'student',alephUserId:'aleph-user',siteId:'site',identityVersion:1,projectId:'review-project'};
const query={package:{name:'example',ecosystem:'npm'},version:'1.0.0'};
const supportBody={model:'example',problemKind:'app-start',observations:{engine:{mode:'disconnected',code:'ENGINE_NOT_CONNECTED'},ai:{configured:false,authorized:false}}};
const kinds=['browser-ai','browser-native','server-ai','server-native','app-authorization','osv','vendor'];
const deadlines={
  'browser-ai':'ALEKOV_CONNECT_CLIENT_TIMEOUT','browser-native':'NATIVE_LOGIN_CLIENT_TIMEOUT','server-ai':'ALEKOV_CONNECT_TIMEOUT',
  'server-native':'NATIVE_HOST_TIMEOUT','app-authorization':'WB_CLCO_TIMEOUT',osv:'unverifiable',vendor:'WB_CLCO_TIMEOUT',
};
const invalid={
  'browser-ai':'ALEKOV_CONNECT_RESPONSE_INVALID','browser-native':'NATIVE_LOGIN_RESPONSE_INVALID','server-ai':'ALEKOV_CONNECT_RESPONSE_INVALID',
  'server-native':'NATIVE_HOST_RESPONSE_INVALID','app-authorization':'WB_CLCO_INVALID_CONTENT_TYPE',osv:'unverifiable',vendor:'WB_CLCO_INVALID_CONTENT_TYPE',
};
function subject(kind,fetchImpl,timeoutMs,t){
  let call,close=()=>{};
  if(kind==='browser-ai')call=signal=>createFetchTransport({fetchImpl,timeoutMs})('status',{}, {signal});
  if(kind==='browser-native')call=signal=>{const deadline=performance.now()+timeoutMs;return createNativeFetchTransport({fetchImpl})('status',{signal,deadline:{left:()=>deadline-performance.now()}});};
  if(kind==='server-ai')call=signal=>createAlekovAppConnector({enabled:true,fetchImpl,timeoutMs,resolveCurrentContext:async()=>context,persistCredential:async()=>null}).begin({signal});
  if(kind==='server-native'){
    const producer=createNativeLogin({enabled:true,fetchImpl,timeoutMs});close=()=>producer.close();call=signal=>producer.start({}, {signal});
  }
  if(kind==='app-authorization'){
    // Synthetic protocol fixture, never an issued credential.
    const verify=createOnAppAuthorizationVerifier({baseUrl:'https://example.test/api/apps/aleph-on/v1',token:'sk-on-'+'a'.repeat(43),fetchImpl,timeoutMs});
    call=signal=>verify({signal,purpose:'explain',requiredCapability:'ai.explain',expectedScope:{subjectId:'student',projectId:'review-project',appId:'aleph-on',audience:'on-client'},expectedContext:{alephUserId:'aleph-user',siteId:'site',identityVersion:1}});
  }
  if(kind==='osv')call=async signal=>{const rows=await createOsvClient({fetchImpl}).lookupPackages([query],{signal,timeoutMs});return {ok:rows[0].status!=='unverifiable',error:{code:rows[0].status}};};
  if(kind==='vendor'){
    t.mock.method(globalThis,'fetch',fetchImpl);
    const client=createClcoClient({baseUrl:'https://example.test/v1',token:'synthetic-fixture',timeoutMs});
    call=signal=>client.learnerSupport(supportBody,{signal});
  }
  t.after(close);
  return async signal=>{try{return await call(signal);}catch(error){return {ok:false,error:{code:error.code}};}};
}
function openResponse({type='application/json',status=200,cancel=()=>{},chunk,headers={}}={}){
  let count=0;
  const body=new ReadableStream({start(controller){if(chunk)controller.enqueue(new TextEncoder().encode(chunk));},cancel(){count++;return cancel();}});
  return {response:new Response(body,{status,headers:{'content-type':type,...headers}}),cancels:()=>count};
}

for(const kind of kinds){
  test(`${kind}: rejected headers/status release the untouched response body`,{timeout:3000},async t=>{
    const stream=openResponse({type:'text/html',status:kind==='osv'?503:200});
    const run=subject(kind,async()=>stream.response,1000,t);
    const result=await run();await turn();
    assert.equal(result.ok,false);assert.equal(result.error.code,invalid[kind]);assert.equal(stream.cancels(),1);
  });
  test(`${kind}: a response arriving after cancellation is discarded without another request`,{timeout:3000},async t=>{
    let deliver,reached;const response=new Promise(resolve=>deliver=resolve),started=new Promise(resolve=>reached=resolve);let calls=0;
    const run=subject(kind,()=>{calls++;reached();return response;},1000,t),controller=new AbortController();
    const pending=run(controller.signal);await started;controller.abort();
    const result=await pending;assert.equal(result.ok,false);
    const stream=openResponse();deliver(stream.response);await turn();
    assert.equal(stream.cancels(),1);assert.equal(calls,1);
  });
  test(`${kind}: the deadline includes a stalled body and cancels its reader`,{timeout:3000},async t=>{
    const stream=openResponse(),run=subject(kind,async()=>stream.response,35,t);
    const result=await run();await turn();
    assert.equal(result.ok,false);assert.equal(result.error.code,deadlines[kind]);assert.equal(stream.cancels(),1);
  });
  test(`${kind}: acquired reader ownership is released even if underlying cancellation never settles`,{timeout:3000},async t=>{
    const stream=openResponse({cancel:()=>new Promise(()=>{})}),run=subject(kind,async()=>stream.response,35,t);
    const result=await run();await turn();
    assert.equal(result.ok,false);assert.equal(result.error.code,deadlines[kind]);assert.equal(stream.cancels(),1);
    assert.equal(stream.response.body.locked,false,'A hanging cancel must not retain the reader lock');
  });
  test(`${kind}: declared oversize cancels the body before acquiring a reader`,{timeout:3000},async t=>{
    const stream=openResponse({headers:{'content-length':'2097152'}});let reads=0;
    t.mock.method(stream.response.body,'getReader',()=>{reads++;throw Error('Declared oversize must not be read');});
    const result=await subject(kind,async()=>stream.response,1000,t)();await turn();
    assert.equal(result.ok,false);assert.equal(reads,0);assert.equal(stream.cancels(),1);
    assert.equal(result.error.code,['app-authorization','vendor'].includes(kind)?'WB_CLCO_RESPONSE_TOO_LARGE':invalid[kind]);
  });
  for(const mode of ['throws','never settles'])test(`${kind}: cleanup that ${mode} cannot hide the original rejection`,{timeout:3000},async t=>{
    const stream=openResponse({type:'text/html',status:kind==='osv'?503:200,cancel:()=>{if(mode==='throws')throw Error('cleanup failure');return new Promise(()=>{});}});
    const result=await subject(kind,async()=>stream.response,1000,t)();await turn();
    assert.equal(result.ok,false);assert.equal(result.error.code,invalid[kind]);assert.equal(stream.cancels(),1);
  });
}

test('browser AI transport bounds actual bytes and accepts a valid bounded success',async()=>{
  let cancellations=0;
  const stream=openResponse({chunk:'x'.repeat(65),cancel:()=>{cancellations++;}});
  const tooLarge=await createFetchTransport({fetchImpl:async()=>stream.response,maxBytes:64})('status',{});
  assert.equal(tooLarge.error.code,'ALEKOV_CONNECT_RESPONSE_INVALID');assert.equal(cancellations,1);
  const valid=await createFetchTransport({fetchImpl:async()=>Response.json({ok:true,data:{state:'checking'}})})('status',{});
  assert.deepEqual(valid,{ok:true,data:{state:'checking'}});
  const unmounted=await createFetchTransport({fetchImpl:async()=>new Response('broken-json',{status:404,headers:{'content-type':'application/json'}})})('status',{});
  assert.equal(unmounted.error.code,'ALEKOV_CONNECT_NOT_MOUNTED','Retain the existing unmounted route classification for malformed 404 bodies');
});
