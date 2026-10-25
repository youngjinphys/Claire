import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createDeviceHandler } from '../api/device.js';
import { createNotesHandler } from '../api/notes.js';
import { createAnnouncementsHandler } from '../api/announcements.js';
import { verifyDeviceGrant } from '../src/device-access.mjs';
const A='11111111-1111-4111-8111-111111111111';
const B='22222222-2222-4222-8222-222222222222';
const NOTE='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CRED='device_credential_0123456789abcd';
const REG='registration_challenge_123456789012345';
const AUTH='authentication_challenge_1234567890123';
const ORIGIN='https://skt-aleph-defense.vercel.app';
const headers=(person='A',proof)=>({
  authorization:person==='A'?'Bearer jwt-A':'Bearer jwt-B',
  origin:ORIGIN,...(proof?{'x-aleph-device-proof':proof}:{})
});
const response=()=>({
  code:null,payload:null,headers:{},
  setHeader(k,v){this.headers[k.toLowerCase()]=v;return this;},
  status(n){this.code=n;return this;},
  json(v){this.payload=v;return this;}
});
function db(){
  const rows={s11_device_credentials:[],s11_device_challenges:[],
    learning_notes:[{id:NOTE,owner_id:A,title:'demo title',content:'private sample',
      created_at:'2026-01-01T00:00:00Z'}],
    learning_announcements:[]};
  return {rows,from(table){
    if(!Object.hasOwn(rows,table))throw Error('unknown table '+table);
    const eq=[],gt=[];
    let op='select',value;
    const query={
      select(){return this;},
      eq(k,v){eq.push([k,v]);return this;},
      gt(k,v){gt.push([k,v]);return this;},
      order(){return this;},
      insert(row){
        if(rows[table].some(r=>(row.challenge && row.challenge===r.challenge)||
            (row.credential_id && row.credential_id===r.credential_id)))
          return Promise.resolve({data:null,error:{code:'23505'}});
        rows[table].push({...row});return Promise.resolve({data:null,error:null});
      },
      update(data){op='update';value=data;return this;},
      delete(){op='delete';return this;},
      maybeSingle(){return this.run(true);},
      then(ok,bad){return this.run(false).then(ok,bad);},
      async run(single){
        const matches=rows[table].filter(row=>eq.every(([k,v])=>row[k]===v)&&
          gt.every(([k,v])=>row[k]>v));
        if(op==='update')for(const row of matches)Object.assign(row,value);
        if(op==='delete')rows[table]=rows[table].filter(row=>!matches.includes(row));
        return {data:single?(matches[0]??null):matches,error:null};
      }
    };
    return query;
  }};
}
const verifier=()=>async auth=>
  auth==='Bearer jwt-A'?{kind:'student',userId:A}:
  auth==='Bearer jwt-B'?{kind:'student',userId:B}:null;
const ceremony=(type,challenge)=>({
  id:CRED,type:'public-key',rawId:CRED,
  response:{clientDataJSON:Buffer.from(JSON.stringify({type,challenge,origin:ORIGIN})).toString('base64url')}
});
const webauthn={
  generateRegistrationOptions:async()=>({challenge:REG}),
  generateAuthenticationOptions:async()=>({challenge:AUTH}),
  verifyRegistrationResponse:async ({expectedChallenge,expectedOrigin,expectedRPID})=>{
    assert.equal(expectedChallenge,REG);assert.equal(expectedOrigin,ORIGIN);
    assert.equal(expectedRPID,'skt-aleph-defense.vercel.app');
    return {verified:true,registrationInfo:{
      userVerified:true,credentialDeviceType:'singleDevice',credentialBackedUp:false,
      credential:{id:CRED,publicKey:Buffer.alloc(65,7),counter:0,transports:['internal']}
    }};
  },
  verifyAuthenticationResponse:async ({expectedChallenge,credential})=>{
    assert.equal(expectedChallenge,AUTH);assert.equal(credential.id,CRED);
    return {verified:true,authenticationInfo:{
      credentialDeviceType:'singleDevice',credentialBackedUp:false,
      newCounter:Number(credential.counter)+1
    }};
  }
};
function setup(){
  const store=db(),env={
    SUPABASE_URL:'https://fixture.supabase.invalid',SUPABASE_SECRET_KEY:'fixture-only'
  };
  let time=Date.parse('2026-10-15T01:00:00.000Z');
  const grant=ctx=>verifyDeviceGrant({...ctx,now:new Date(time).toISOString()});
  return {
    store,clock:{advance:n=>{time+=n}},
    device:createDeviceHandler({env,webauthn,supabaseFactory:()=>store,
      verifierFactory:verifier,clock:()=>time}),
    notes:createNotesHandler({env,supabaseFactory:()=>store,
      verifierFactory:verifier,deviceGrantVerifier:grant}),
    announcements:createAnnouncementsHandler({env,supabaseFactory:()=>store,
      verifierFactory:verifier,deviceGrantVerifier:grant})
  };
}
async function call(handler,action,body,person='A',proof){
  const r=response();
  await handler({method:action?(action==='status'?'GET':'POST'):'GET',
    query:action?{action}:{},headers:headers(person,proof),
    body:body===undefined?undefined:JSON.stringify(body)},r);
  return r;
}
async function register(x){
  assert.equal((await call(x.device,'registration-options',{})).code,200);
  return call(x.device,'registration-verify',{
    credential:ceremony('webauthn.create',REG)
  });
}
async function sign(x){
  assert.equal((await call(x.device,'assertion-options',{})).code,200);
  return call(x.device,'assertion-verify',{
    credential:ceremony('webauthn.get',AUTH)
  });
}
test('S11_DATA_BEFORE_APPROVAL: password alone and installation badge cannot expose protected records',async()=>{
  const x=setup(),notes=await call(x.notes);
  assert.equal(notes.code,403);assert.equal(notes.payload.error,'DEVICE_NOT_VERIFIED');
  assert.equal((await call(x.announcements)).code,403);
  assert.equal((await call(x.device,'status')).payload.canOpenVault,false);
});
test('S11_BADGE_IS_TRUST: registration options and request button are not approval',async()=>{
  const x=setup();
  assert.equal((await call(x.device,'registration-options',{})).code,200);
  const state=await call(x.device,'status');
  assert.equal(state.payload.registration,'not_registered');
  assert.equal(state.payload.canOpenVault,false);
  assert.equal((await call(x.notes)).code,403);
});
test('S11_APPROVED_SCREEN_CLOSED: approved registration plus new authenticator assertion opens the original vault',async()=>{
  const x=setup(),reg=await register(x);
  assert.equal(reg.code,200);assert.equal(reg.payload.verifiedDeviceProof,false);
  assert.equal((await call(x.notes)).code,403);
  const proof=(await sign(x)).payload.proof;
  assert.match(proof,/^[A-Za-z0-9_-]{40,100}$/u);
  assert.equal((await call(x.device,'status',undefined,'A',proof)).payload.canOpenVault,true);
  const normal=await call(x.notes,undefined,undefined,'A',proof);
  assert.equal(normal.code,200);assert.equal(normal.payload[0].body,'private sample');
  assert.equal((await call(x.notes,undefined,undefined,'B',proof)).code,403);
  assert.equal((await call(x.notes)).code,403);
});
test('revocation, expiration and missing grant fail closed',async()=>{
  const x=setup();await register(x);
  const proof=(await sign(x)).payload.proof;
  assert.equal((await call(x.notes,undefined,undefined,'A',proof)).code,200);
  x.clock.advance(901000);
  assert.equal((await call(x.notes,undefined,undefined,'A',proof)).code,403);
  x.clock.advance(-901000);
  x.store.rows.s11_device_credentials[0].status='revoked';
  assert.equal((await call(x.notes,undefined,undefined,'A',proof)).code,403);
});
test('WebAuthn challenge is single-use, origin check prevents cross-origin initiation',async()=>{
  const x=setup();await register(x);
  const replay=await call(x.device,'registration-verify',{
    credential:ceremony('webauthn.create',REG)
  });
  assert.equal(replay.code,409);
  const r=response();
  await x.device({method:'POST',query:{action:'registration-options'},
    headers:{...headers(),origin:'https://attacker.example'},body:'{}'},r);
  assert.equal(r.code,403);
});
test('the UI keeps the old workspace locked and never stores proofs in browser storage',()=>{
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const browser=readFileSync(new URL('../public/device.mjs',import.meta.url),'utf8');
  const gate=readFileSync(new URL('../src/device-access.mjs',import.meta.url),'utf8');
  const sw=readFileSync(new URL('../public/sw.js',import.meta.url),'utf8');
  assert.match(html,/id="workspace"[^>]*hidden/u);
  assert.match(html,/workspace\.hidden = !\(loggedIn && Boolean\(deviceProof\)\)/u);
  assert.doesNotMatch(html+browser,/localStorage|sessionStorage|indexedDB/u);
  assert.doesNotMatch(gate,/pwa-state|appinstalled|beforeinstallprompt/u);
  assert.doesNotMatch(sw,/cache\.put\(event\.request/u);
});
