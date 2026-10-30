import assert from 'node:assert/strict';
import {test} from 'node:test';
import config from '../aleph.config.json' with {type:'json'};
import {compareDeploymentIdentity} from '../src/deployment-evidence.mjs';
import {checkLiveIdentity} from '../scripts/verify-live-identity.mjs';

const commit='a'.repeat(40);
const canonical=()=>({
  schema:'aleph.defense.deployment.v1',step:config.step,
  repoUrl:config.repoUrl,publicAppUrl:config.publicAppUrl,
  judgeIssuer:config.judgeIssuer,originalApiUrl:config.originalApiUrl,
  restoreRoute:config.restoreRoute,allowedRoutes:[...config.allowedRoutes],
  protectedService:{...config.protectedService},
  resourceZones:structuredClone(config.resourceZones),commit,
});
const response=(body,options={})=>new Response(JSON.stringify(body),{
  status:options.status??200,headers:{'content-type':'application/json',
    'cache-control':'no-store',...options.headers},
});
test('full identity verifies, including semantic object equality',()=>{
  const manifest=canonical();
  manifest.resourceZones=Object.fromEntries(Object.entries(manifest.resourceZones).reverse());
  assert.deepEqual(compareDeploymentIdentity(manifest,config,commit),{
    outcome:'verified',reason:'IDENTITY_CONSISTENT',
  });
});
test('manifest never verifies if repository, alias, issuer, routes or SHA diverge',()=>{
  for(const key of ['repoUrl','publicAppUrl','judgeIssuer','originalApiUrl','restoreRoute',
    'allowedRoutes','protectedService','resourceZones','commit']){
    const manifest=canonical();
    manifest[key]=key==='commit'?'b'.repeat(40):null;
    const outcome=compareDeploymentIdentity(manifest,config,commit);
    assert.equal(outcome.outcome,'failed',key);
  }
  assert.equal(compareDeploymentIdentity(canonical(),config,null).outcome,'inconclusive');
});
test('live checker performs one anonymous bounded GET and distinguishes stale',async()=>{
  const calls=[];
  const fetchImpl=async(url,opts)=>{
    calls.push({url,opts});
    return response(canonical());
  };
  const matched=await checkLiveIdentity({config,expectedCommit:commit,fetchImpl});
  assert.equal(matched.status,'verified');
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,config.publicAppUrl+'/aleph.json');
  assert.equal(calls[0].opts.method,'GET');
  assert.equal(calls[0].opts.redirect,'error');
  assert.equal(calls[0].opts.credentials,'omit');
  const stale=await checkLiveIdentity({config,expectedCommit:'b'.repeat(40),fetchImpl});
  assert.equal(stale.status,'stale');
  assert.equal(stale.deployedCommit,commit);
});
test('unavailable, malformed, oversized and redirected public evidence never verifies',async()=>{
  const broken=[
    async()=>response(canonical(),{status:503}),
    async()=>response(canonical(),{headers:{'cache-control':'public,max-age=60'}}),
    async()=>new Response('not-json',{headers:{'content-type':'application/json','cache-control':'no-store'}}),
    async()=>new Response('x'.repeat(8193),{headers:{'content-type':'application/json','cache-control':'no-store'}}),
    async()=>{throw Error('blocked')},
  ];
  for(const fetchImpl of broken){
    const result=await checkLiveIdentity({config,expectedCommit:commit,fetchImpl});
    assert.equal(result.status,'unverifiable');
  }
  const result=await checkLiveIdentity({
    config:{...config,publicAppUrl:'https://127.0.0.1'},
    expectedCommit:commit,fetchImpl:()=>{throw Error('must never fetch');}
  });
  assert.equal(result.status,'unverifiable');
});
