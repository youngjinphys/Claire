import assert from 'node:assert/strict';
import {test} from 'node:test';
import config from '../aleph.config.json' with {type:'json'};
import {checkLiveIdentity} from '../scripts/verify-live-identity.mjs';

const expectedCommit='a'.repeat(40);
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function stream({type='application/json',cancel=()=>{}}={}){
  let cancelled=0;
  const response=new Response(new ReadableStream({cancel(){cancelled++;return cancel();}}),{headers:{'content-type':type,'cache-control':'no-store'}});
  return {response,cancelled:()=>cancelled};
}
test('live identity rejects MIME without waiting for cancellation to finish', {timeout:3000},async()=>{
  const body=stream({type:'text/html',cancel:()=>new Promise(()=>{})});
  const result=await checkLiveIdentity({config,expectedCommit,fetchImpl:async()=>body.response,timeoutMs:1000});
  assert.equal(result.status,'unverifiable');assert.equal(body.cancelled(),1);
});
test('live identity deadline covers an uncooperative fetch and disposes its late response', {timeout:3000},async()=>{
  let deliver;const response=new Promise(resolve=>deliver=resolve);
  const result=await checkLiveIdentity({config,expectedCommit,fetchImpl:()=>response,timeoutMs:100});
  assert.equal(result.status,'unverifiable');
  const body=stream();deliver(body.response);await turn();assert.equal(body.cancelled(),1);
});
test('live identity deadline cancels a stalled response reader', {timeout:3000},async()=>{
  const body=stream();
  const result=await checkLiveIdentity({config,expectedCommit,fetchImpl:async()=>body.response,timeoutMs:100});
  assert.equal(result.status,'unverifiable');assert.equal(body.cancelled(),1);
});
