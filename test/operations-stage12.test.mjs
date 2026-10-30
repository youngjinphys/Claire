import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROBES, operationsSnapshot, summarizeObservations } from '../src/operations.mjs';
import { createOperationsHandler } from '../api/ops.js';
import config from '../aleph.config.json' with { type: 'json' };

function fakeResponse(status, body, extra={}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type':'application/json','cache-control':'no-store',
      'x-vercel-id':'icn1::example-req',...extra,
    },
  });
}
const req = (auth) => ({method:'GET',headers:auth?{authorization:auth}:{}});
const commit='a'.repeat(40);
const identity=()=>({
  schema:'aleph.defense.deployment.v1',step:config.step,commit,
  repoUrl:config.repoUrl,publicAppUrl:config.publicAppUrl,
  judgeIssuer:config.judgeIssuer,originalApiUrl:config.originalApiUrl,
  restoreRoute:config.restoreRoute,allowedRoutes:[...config.allowedRoutes],
  protectedService:{...config.protectedService},resourceZones:structuredClone(config.resourceZones),
});
async function serve(handler,input) {
  const h=new Map();let code;let json;
  await handler(input,{setHeader:(k,v)=>h.set(k,v),status:n=>{code=n;return {json:b=>{json=b;}}}});
  return {code,json,headers:h};
}
test('zero official pass credit and 41 attacks remain unexecuted',()=>{
  const report=operationsSnapshot([{id:'anonymous_notes',httpStatus:401,outcome:'verified',
    requestId:'icn1::abc',checkedAt:'2026-10-14T01:00:00Z'}]);
  assert.equal(report.verdict.attackTypesVerified,0);
  assert.equal(report.verdict.stagesVerified,0);
  assert.equal(report.verdict.complete,false);
  assert.equal(report.summary.verified,1);
  assert.equal(report.records[0].requestId,'icn1::abc');
  assert.deepEqual(summarizeObservations(report.records),report.summary);
});
test('only redacted actual HTTP data, no note bodies or bearer secrets',async()=>{
  const calls=[];
  const handler=createOperationsHandler({
    env:{VERCEL_URL:'private-preview.vercel.app',VERCEL_GIT_COMMIT_SHA:commit},
    clock:()=> '2026-10-14T01:00:00.000Z',
    fetchImpl:async (url,opts)=>{
      calls.push({url:String(url),options:opts});
      if(String(url).endsWith('/aleph.json')) return fakeResponse(200,identity());
      if(String(url).endsWith('/data.json')) return fakeResponse(200,{notes:[]});
      if(String(url).includes('/restore/')) return fakeResponse(503,{error:'RESTORE_DISABLED'});
      if(opts.headers.Authorization) return fakeResponse(200,{title:'SENSITIVE',body:'DONOTSHOW'},
        {'x-resource-zone':'memo'});
      return fakeResponse(401,{error:'UNAUTHORIZED'},
        {'www-authenticate':'Bearer'});
    },
  });
  const token='Bearer '+'a'.repeat(45);
  const {code,json,headers}=await serve(handler,req(token));
  assert.equal(code,200);
  assert.equal(json.records.length,PROBES.length);
  assert.equal(json.summary.verified,4);
  assert.equal(json.summary.inconclusive,1);
  assert.equal(json.verdict.attackTypesVerified,0);
  assert.ok(json.records.find(x=>x.id==='authenticated_notes').httpStatus===200);
  assert.ok(!JSON.stringify(json).includes('SENSITIVE'));
  assert.ok(!JSON.stringify(json).includes('DONOTSHOW'));
  assert.ok(!JSON.stringify(json).includes(token));
  assert.equal(headers.get('Cache-Control'),'no-store');
  assert.ok(calls.every(c=>c.url.startsWith('https://private-preview.vercel.app/')));
  assert.equal(calls.filter(c=>c.options.headers.Authorization).length,1);
});
test('without session, signed-in normal read remains unrun',async()=>{
  const handler=createOperationsHandler({fetchImpl:async()=>fakeResponse(503,{error:'NOTES_BACKEND_NOT_CONFIGURED'})});
  const result=await serve(handler,req());
  const own=result.json.records.find(x=>x.id==='authenticated_notes');
  assert.equal(own.outcome,'unrun');
  assert.equal(own.checkedAt,null);
  assert.equal(own.requestId,null);
  assert.equal(result.json.verdict.complete,false);
});
test('write methods never probe, reject before touching network',async()=>{
  const handler=createOperationsHandler({fetchImpl:()=>{throw Error('must not fetch');}});
  const result=await serve(handler,{method:'POST',headers:{}});
  assert.equal(result.code,405);
});

test('deployment observation rejects stale SHA and wrong public alias',async()=>{
  for(const [variant,expected] of [
    [{commit:'b'.repeat(40)},'failed'],
    [{publicAppUrl:'https://other.vercel.app'},'failed'],
    [{repoUrl:'https://github.com/another/repo'},'failed'],
    [{allowedRoutes:[]},'failed'],
    [{},'verified']
  ]){
    const manifest={...identity(),...variant};
    const handler=createOperationsHandler({
      env:{VERCEL_URL:'preview-ci.vercel.app',VERCEL_GIT_COMMIT_SHA:commit},
      fetchImpl:async(url)=>String(url).endsWith('/aleph.json')
        ?fakeResponse(200,manifest):fakeResponse(503,{error:'UNAVAILABLE'}),
    });
    const result=await serve(handler,req());
    assert.equal(result.json.records.find(x=>x.id==='deployment_manifest').outcome,expected);
  }
});
test('deployment observation is inconclusive without server-provided build SHA',async()=>{
  const handler=createOperationsHandler({
    env:{VERCEL_URL:'preview-ci.vercel.app'},
    fetchImpl:async(url)=>String(url).endsWith('/aleph.json')
      ?fakeResponse(200,identity()):fakeResponse(503,{error:'UNAVAILABLE'}),
  });
  const result=await serve(handler,req());
  assert.equal(result.json.records.find(x=>x.id==='deployment_manifest').outcome,'inconclusive');
});

test('the operations reader enforces a byte bound even without Content-Length',async()=>{
  const badBody=new Response(new ReadableStream({
    start(controller){controller.enqueue(new Uint8Array(4096));controller.close();}
  }),{status:200,headers:{'content-type':'application/json','cache-control':'no-store'}});
  const handler=createOperationsHandler({
    env:{VERCEL_URL:'claire-test.vercel.app',VERCEL_GIT_COMMIT_SHA:commit},
    fetchImpl:async(url)=>String(url).endsWith('/aleph.json')
      ?badBody:fakeResponse(503,{error:'NOTES_BACKEND_NOT_CONFIGURED'}),
  });
  const response=await serve(handler,req());
  assert.equal(response.code,200);
  assert.equal(response.json.records.find(row=>row.id==='deployment_manifest').outcome,'failed');
  assert.equal(response.json.verdict.complete,false);
});

test('bogus Content-Length and cacheable restore denial never count as verified',async()=>{
  const handler=createOperationsHandler({
    env:{VERCEL_URL:'claire-test.vercel.app',VERCEL_GIT_COMMIT_SHA:commit},
    fetchImpl:async(url)=>{
      if(String(url).endsWith('/aleph.json'))return fakeResponse(200,identity(),
        {'content-length':'999999'});
      if(String(url).includes('/restore/'))return fakeResponse(403,{error:'UNAUTHORIZED'},
        {'cache-control':'public, max-age=600'});
      return fakeResponse(503,{error:'NOTES_BACKEND_NOT_CONFIGURED'});
    },
  });
  const response=await serve(handler,req());
  assert.equal(response.json.records.find(row=>row.id==='deployment_manifest').outcome,'failed');
  assert.equal(response.json.records.find(row=>row.id==='anonymous_restore').outcome,'failed');
  assert.equal(response.json.summary.verified,0);
});
