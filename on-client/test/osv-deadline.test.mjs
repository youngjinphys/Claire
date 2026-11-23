import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createOsvClient} from '../src/vulnerabilities/osv.mjs';

const query={package:{name:'example',ecosystem:'npm'},version:'1.0.0'};
const finding=(id,modified='2025-01-01T00:00:00Z')=>({id,modified});
test('OSV combines large duplicate pages by id and retains the newest modification',async()=>{
  const count=12000,older=Array.from({length:count},(_,i)=>finding(`OSV-${i}`)),newer=older.map(row=>finding(row.id,'2026-01-01T00:00:00Z'));
  let calls=0;
  const client=createOsvClient({fetchImpl:async(_,options)=>{
    const input=JSON.parse(options.body);calls++;
    assert.equal(input.queries[0].page_token,calls===1?undefined:'second');
    return Response.json({results:[{vulns:calls===1?older:[...newer,finding('OSV-0','2024-01-01T00:00:00Z')],...(calls===1?{next_page_token:'second'}:{})}]});
  }});
  const [row]=await client.lookupPackages([query]);
  assert.equal(calls,2);assert.equal(row.status,'known_vulnerabilities');assert.equal(row.vulnerabilities.length,count);
  assert.equal(new Set(row.vulnerabilities.map(v=>v.id)).size,count);
  assert.ok(row.vulnerabilities.every(v=>v.modified==='2026-01-01T00:00:00Z'));
});
test('OSV expires during synchronous row work without waiting for timer delivery and retains earlier findings',async()=>{
  let calls=0,checks=0;
  const client=createOsvClient({monotonic:()=>calls===2&&++checks>50?1000:0,fetchImpl:async()=>{
    calls++;
    return Response.json({results:[calls===1?{vulns:[finding('OSV-OBSERVED')],next_page_token:'second'}:
      {vulns:Array.from({length:1000},(_,i)=>finding(`OSV-${i}`)),next_page_token:'third'}]});
  }});
  const [row]=await client.lookupPackages([query],{timeoutMs:1000});
  assert.equal(calls,2,'No later page may start after the synchronous deadline');
  assert.equal(row.status,'unverifiable');assert.deepEqual(row.vulnerabilities,[finding('OSV-OBSERVED')]);
});
test('OSV never publishes a complete clean result after a fetch has consumed the whole deadline',async()=>{
  let time=0;
  const client=createOsvClient({monotonic:()=>time,fetchImpl:async()=>{time=1000;return Response.json({results:[{}]});}});
  const [row]=await client.lookupPackages([query],{timeoutMs:1000});
  assert.equal(row.status,'unverifiable');assert.deepEqual(row.vulnerabilities,[]);
});
test('OSV retains completed and partial evidence but downgrades every status if the whole lookup expires',async()=>{
  let time=0,calls=0;
  const client=createOsvClient({monotonic:()=>time,fetchImpl:async()=>{
    if(++calls===1)return Response.json({results:[{}, {vulns:[finding('OSV-PARTIAL')],next_page_token:'second'}]});
    time=1000;return Response.json({results:[{}]});
  }});
  const rows=await client.lookupPackages([query,{package:{name:'second',ecosystem:'npm'},version:'1.0.0'}],{timeoutMs:1000});
  assert.deepEqual(rows.map(row=>row.status),['unverifiable','unverifiable']);
  assert.deepEqual(rows[1].vulnerabilities,[finding('OSV-PARTIAL')]);
});
