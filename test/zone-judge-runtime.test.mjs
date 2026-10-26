import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {copyFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPair,SignJWT} from 'jose';
import config from '../aleph.config.json' with {type:'json'};
import {createLoginVerifier} from '../src/verify-login.mjs';
import {createNotesHandler} from '../api/notes.js';
import {createAnnouncementsHandler} from '../api/announcements.js';
import {fixtureRequests} from '../scripts/fixture-7.mjs';
import {decide} from '../src/decider.mjs';
import {runAttackChecks} from '../src/attack-check.mjs';

const A='11111111-1111-4111-8111-111111111111';
const B='22222222-2222-4222-8222-222222222222';
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const deployment='choi-bujang-secret-vault-9yc6y1pv4.vercel.app';
const alias=new URL(config.publicAppUrl).hostname;
async function token(key,sub,aud) {
  return new SignJWT({aleph_run:'77777777-7777-4777-8777-777777777777',
    aleph_role:'judge',aleph_identity:sub===A?'a':'b'})
    .setProtectedHeader({alg:'ES256'}).setIssuer(config.judgeIssuer)
    .setAudience(aud).setSubject(sub).setIssuedAt().setExpirationTime('10m').sign(key);
}
function mockDb(){
  const note={id,owner_id:A,title:'Synthetic A',content:'Training',created_at:'2026-01-01'};
  return {
    auth:{getClaims:async()=>({data:{claims:null},error:null}),
      admin:{getUserById:async()=>({data:{user:null},error:null})}},
    from(name){
      const predicates=[];
      return {
        select(){return this;},
        eq(k,v){predicates.push([k,v]);return this;},
        order(){return this;},
        maybeSingle:async()=>({data:name==='learning_notes'&&predicates.every(([k,v])=>note[k]===v)?note:null,error:null}),
        then(resolve,reject){const exists=name==='learning_notes'&&predicates.every(([k,v])=>note[k]===v);
          return Promise.resolve({data:exists?[note]:[],error:null}).then(resolve,reject);}
      };
    }
  };
}
function res(){return{code:0,payload:null,headers:{},setHeader(k,v){this.headers[k]=v;return this;},
  status(n){this.code=n;return this;},json(v){this.payload=v;return this;}};}
async function req(handle,jwt,method,item){
  const result=res();
  await handle({method,headers:{authorization:jwt?'Bearer '+jwt:undefined},
    query:item?{id:item}:{},body:{}},result);
  return result;
}
test('Cryptographic judge JWT: alias and exact deployment audience, cross-owner and student-deny',async()=>{
  const {publicKey,privateKey}=await generateKeyPair('ES256');
  const db=mockDb();
  const options={config,supabaseClient:db,judgeKeySet:async()=>publicKey,deploymentHost:deployment};
  const verify=createLoginVerifier(options);
  const a=await token(privateKey,A,alias),b=await token(privateKey,B,deployment);
  const hostile=await token(privateKey,A,'unrelated-project.vercel.app');
  assert.equal((await verify('Bearer '+a))?.userId,A);
  assert.equal((await verify('Bearer '+b))?.userId,B);
  assert.equal(await verify('Bearer '+hostile),null);
  const noDeployment=createLoginVerifier({...options,deploymentHost:null});
  assert.equal(await noDeployment('Bearer '+b),null);
  const factories={env:{SUPABASE_URL:'https://fake.supabase.invalid',SUPABASE_SECRET_KEY:'fake-only'},
    supabaseFactory:()=>db,verifierFactory:()=>verify};
  const notes=createNotesHandler(factories),announcements=createAnnouncementsHandler(factories);
  assert.equal((await req(notes,a,'GET',id)).code,200);
  assert.equal((await req(notes,b,'GET',id)).code,404);
  assert.deepEqual((await req(notes,b,'GET',null)).payload,[]);
  assert.equal((await req(notes,hostile,'GET',id)).code,401);
  assert.equal((await req(announcements,b,'PUT',id)).code,403);
});
test('Standalone judge module runs without any sibling files or network',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'isolated-decider-'));
  try{
    await copyFile(new URL('../src/decider.mjs',import.meta.url),join(dir,'decider.mjs'));
    const request=fixtureRequests().normal;
    const cases=[request,{...request,path:'/notes'},
      {...request,path:'/announcements/notice-demo',method:'PUT',route:'PUT /announcements/:id'}];
    const program='globalThis.fetch=()=>{throw Error("no network")};'+
      'const m=await import("./decider.mjs");const xs='+JSON.stringify(cases)+';'+
      'console.log(JSON.stringify(await Promise.all(xs.map(x=>m.decide(x)))));';
    const child=spawnSync(process.execPath,['--input-type=module','--eval',program],
      {cwd:dir,encoding:'utf8',timeout:5000,env:{PATH:process.env.PATH??''}});
    assert.equal(child.status,0,child.stderr||String(child.error));
    const result=JSON.parse(child.stdout);
    assert.deepEqual(result.map(v=>v.decision),['allow','deny','deny']);
    assert.ok(result.every(v=>Object.keys(v).sort().join(',')==='decision,reasonCode,requestId,ruleIds,schema'));
  }finally{await rm(dir,{recursive:true,force:true})}
});
test('Platform SSO 401 HTML is not confused with handler Bearer401 JSON',async()=>{
  const saved=globalThis.fetch;
  const current={...config,step:8,publicAppUrl:'https://example-stage8.vercel.app'};
  const manifest=()=>new Response(JSON.stringify({step:8,resourceZones:config.resourceZones,
    allowedRoutes:config.allowedRoutes}),{status:200,headers:{'Content-Type':'application/json'}});
  try{
    globalThis.fetch=async url=>new URL(String(url)).pathname==='/aleph.json'?manifest():
      new Response('<html>Vercel Authentication required</html>',{status:401,headers:{'Content-Type':'text/html'}});
    const blocked=await runAttackChecks(current);
    assert.match(blocked.find(x=>x.attackId==='anonymous_note_zone_denied').observed,/미확인/);
    assert.match(blocked.find(x=>x.attackId==='anonymous_notice_zone_denied').observed,/미확인/);
    globalThis.fetch=async url=>new URL(String(url)).pathname==='/aleph.json'?manifest():
      new Response(JSON.stringify({error:'UNAUTHORIZED'}),{status:401,headers:{
        'WWW-Authenticate':'Bearer','Cache-Control':'no-store','Content-Type':'application/json'}});
    const pass=await runAttackChecks(current);
    assert.match(pass.find(x=>x.attackId==='anonymous_note_zone_denied').observed,/401/);
    assert.match(pass.find(x=>x.attackId==='anonymous_notice_zone_denied').observed,/401/);
  }finally{globalThis.fetch=saved}
});
test('Memo collection list route must not get an accidental allow',async()=>{
  const a=fixtureRequests().normal;
  const result=await decide({...a,path:'/notes'});
  assert.equal(result.decision,'deny');
});
