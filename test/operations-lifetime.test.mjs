import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createOperationsHandler} from '../api/ops.js';
import {PROBES} from '../src/operations.mjs';
import config from '../aleph.config.json' with {type:'json'};

const commit='a'.repeat(40),token='Bearer '+'a'.repeat(45);
const env={VERCEL_URL:'operations-fixture.vercel.app',VERCEL_GIT_COMMIT_SHA:commit};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const identity=()=>({schema:'aleph.defense.deployment.v1',step:config.step,commit,
  repoUrl:config.repoUrl,publicAppUrl:config.publicAppUrl,judgeIssuer:config.judgeIssuer,originalApiUrl:config.originalApiUrl,
  restoreRoute:config.restoreRoute,allowedRoutes:[...config.allowedRoutes],protectedService:{...config.protectedService},resourceZones:structuredClone(config.resourceZones)});
const json=(status,body,headers={})=>Response.json(body,{status,headers:{'cache-control':'no-store',...headers}});
function healthy(url,options){
  const path=new URL(url).pathname;
  if(path==='/aleph.json')return json(200,identity());
  if(path==='/data.json')return json(200,{notes:[]});
  if(path.startsWith('/api/restore/'))return json(503,{error:'RESTORE_DISABLED'});
  if(options.headers.Authorization)return json(200,{body:'PRIVATE_FIXTURE_MUST_NOT_BE_READ'},{'x-resource-zone':'memo'});
  return json(401,{error:'UNAUTHORIZED'},{'www-authenticate':'Bearer'});
}
async function serve(fetchImpl,{authorization=token,probeTimeoutMs=100}={}){
  let status,body;const headers=new Map();
  const handler=createOperationsHandler({fetchImpl,env,probeTimeoutMs,clock:()=> '2026-10-14T01:00:00.000Z'});
  await handler({method:'GET',headers:authorization?{authorization}:{}},{setHeader:(key,value)=>headers.set(key,value),status:code=>{status=code;return {json:value=>body=value};}});
  return {status,body,headers};
}
const record=(result,id)=>result.body.records.find(row=>row.id===id);
function bodyProbe(t,{status=200,type='application/json',headers={},cancel=()=>{},chunk}={}){
  let cancellations=0,reads=0;
  const body=new ReadableStream({start(controller){if(chunk)controller.enqueue(new TextEncoder().encode(chunk));},cancel(){cancellations++;return cancel();}});
  const response=new Response(body,{status,headers:{'content-type':type,'cache-control':'no-store',...headers}});
  const getReader=body.getReader.bind(body);t.mock.method(body,'getReader',(...args)=>{reads++;return getReader(...args);});
  return {response,reads:()=>reads,cancellations:()=>cancellations};
}

test('operations deadlines bound an ignored fetch signal, retain independent records, and discard the late response', {timeout:3000},async t=>{
  const late=deferred(),calls=[];let requestSignal;
  const result=await serve((url,options)=>{
    calls.push({url:String(url),method:options.method,headers:options.headers});
    if(new URL(url).pathname==='/aleph.json'){requestSignal=options.signal;return late.promise;}
    return healthy(url,options);
  });
  assert.equal(result.status,200);assert.equal(requestSignal.aborted,true);
  assert.equal(record(result,'deployment_manifest').outcome,'inconclusive');assert.equal(record(result,'deployment_manifest').httpStatus,null);
  assert.equal(record(result,'static_redaction').outcome,'verified');assert.equal(record(result,'anonymous_notes').outcome,'verified');
  assert.equal(record(result,'anonymous_restore').outcome,'inconclusive');assert.equal(record(result,'anonymous_restore').httpStatus,503);
  assert.equal(record(result,'authenticated_notes').outcome,'verified');
  assert.deepEqual(calls.map(call=>new URL(call.url).pathname),PROBES.map(probe=>probe.path));
  assert.ok(calls.every(call=>call.method==='GET'&&new URL(call.url).origin==='https://operations-fixture.vercel.app'));
  assert.equal(calls.filter(call=>call.headers.Authorization).length,1);
  const body=bodyProbe(t);late.resolve(body.response);await turn();
  assert.equal(body.reads(),0);assert.equal(body.cancellations(),1);assert.equal(calls.length,PROBES.length);
  assert.ok(!JSON.stringify(result.body).includes(token));
});
test('operations deadline cancels a stalled body reader without blocking the other probes', {timeout:3000},async t=>{
  const body=bodyProbe(t);
  const result=await serve((url,options)=>new URL(url).pathname==='/aleph.json'?body.response:healthy(url,options));
  assert.equal(record(result,'deployment_manifest').outcome,'inconclusive');assert.equal(body.reads(),1);assert.equal(body.cancellations(),1);
  assert.equal(record(result,'static_redaction').outcome,'verified');assert.equal(record(result,'anonymous_notes').outcome,'verified');
});
for(const mode of ['throws','never settles'])test(`unread authenticated bodies stay unread when cancellation ${mode}`, {timeout:3000},async t=>{
  const body=bodyProbe(t,{headers:{'x-resource-zone':'memo'},cancel:()=>{if(mode==='throws')throw Error('cleanup failure');return new Promise(()=>{});}});
  const result=await serve((url,options)=>options.headers.Authorization?body.response:healthy(url,options));
  assert.equal(record(result,'authenticated_notes').outcome,'verified');assert.equal(body.reads(),0);assert.equal(body.cancellations(),1);
});
for(const status of [200,401,503])test(`authenticated HTTP ${status} is classified without consuming any body`,async t=>{
  const body=bodyProbe(t,{status,headers:{'x-resource-zone':'memo'}});
  const result=await serve((url,options)=>options.headers.Authorization?body.response:healthy(url,options));
  const row=record(result,'authenticated_notes');
  assert.equal(row.outcome,status===200?'verified':status===503?'inconclusive':'failed');assert.equal(row.httpStatus,status);
  assert.equal(row.errorCode,null);assert.equal(body.reads(),0);assert.equal(body.cancellations(),1);
});
for(const path of ['/api/notes','/api/restore/notes/cccccccc-cccc-4ccc-8ccc-cccccccccccc'])test(`unexpected anonymous success at ${path} never reads a private body`,async t=>{
  const body=bodyProbe(t,{cancel:()=>new Promise(()=>{})});
  const result=await serve((url,options)=>new URL(url).pathname===path&&!options.headers.Authorization?body.response:healthy(url,options));
  assert.equal(record(result,path==='/api/notes'?'anonymous_notes':'anonymous_restore').outcome,'failed');
  assert.equal(body.reads(),0);assert.equal(body.cancellations(),1);
});
for(const rejection of ['mime','declared size','actual size'])test(`operations ${rejection} rejection cleans up without waiting for cancellation`,async t=>{
  const body=bodyProbe(t,{type:rejection==='mime'?'text/html':'application/json',headers:rejection==='declared size'?{'content-length':'3501'}:{},
    chunk:rejection==='actual size'?'x'.repeat(3501):undefined,cancel:()=>new Promise(()=>{})});
  const result=await serve((url,options)=>new URL(url).pathname==='/aleph.json'?body.response:healthy(url,options));
  assert.equal(record(result,'deployment_manifest').outcome,'failed');assert.equal(body.reads(),rejection==='actual size'?1:0);assert.equal(body.cancellations(),1);
});
test('operations checks monotonic deadlines after synchronous fetch work before reading or publishing success',async t=>{
  const body=bodyProbe(t);let first=true;
  const result=await serve((url,options)=>{
    if(first){first=false;const end=performance.now()+20;while(performance.now()<end){}return body.response;}
    return healthy(url,options);
  },{probeTimeoutMs:5,authorization:null});
  assert.equal(record(result,'deployment_manifest').outcome,'inconclusive');assert.equal(body.reads(),0);assert.equal(body.cancellations(),1);
  assert.equal(record(result,'authenticated_notes').outcome,'unrun');
});
test('operations refuses invalid deadline overrides before starting probes',()=>{
  for(const probeTimeoutMs of [0,-1,1.5,6501,2147483648,NaN,Infinity])
    assert.throws(()=>createOperationsHandler({probeTimeoutMs}),{message:'INVALID_OPERATIONS_TIMEOUT'});
});
