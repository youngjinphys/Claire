import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROBES, operationsSnapshot, summarizeObservations } from '../src/operations.mjs';
import { createOperationsHandler } from '../api/ops.js';
import config from '../aleph.config.json' with { type: 'json' };

function fakeResponse(status, body, extra={}) {
  const headers = new Map(Object.entries({
    'content-type':'application/json','cache-control':'no-store',
    'x-vercel-id':'icn1::example-req',...extra,
  }));
  return {status,headers:{get:x=>headers.get(x.toLowerCase()) ?? null},
    text:async()=>JSON.stringify(body)};
}
const req = (auth) => ({method:'GET',headers:auth?{authorization:auth}:{}});
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
    env:{VERCEL_URL:'private-preview.vercel.app'},
    clock:()=> '2026-10-14T01:00:00.000Z',
    fetchImpl:async (url,opts)=>{
      calls.push({url:String(url),options:opts});
      if(String(url).endsWith('/aleph.json')) return fakeResponse(200,{
        schema:'aleph.defense.deployment.v1',step:12,
        repoUrl:config.repoUrl});
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
