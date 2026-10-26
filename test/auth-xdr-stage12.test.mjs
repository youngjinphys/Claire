import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAuthHandler } from '../api/auth.js';
import { classifyVerifiedLoginFailures, suspiciousAuthInput, validLoginInput,
  verifiedEdgeAddress, createAuthRiskGuard } from '../src/auth-xdr.mjs';

const env = {
  VERCEL: '1', SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_PUBLISHABLE_KEY:'publishable_test', SUPABASE_SECRET_KEY:'service_role_test_secret_key_1234567890',
};
const goodBody = {email:'learner+test@example.com',password:'strong@examplePass#1'};
const liveSession = {access_token:'fake-access-token',refresh_token:'fake-refresh-token',
  expires_at:1793000000,user:{email:goodBody.email}};
function harness({signIn, claim, record, extra = {}} = {}) {
  const calls = {backend:0, signIn:0, claim:0, record:0, email:null};
  const supabaseFactory = () => {
    calls.backend++;
    return { auth: {
      async signInWithPassword(input) {
        calls.signIn++;
        return signIn ? signIn(input) : {data:{session:liveSession},error:null};
      },
      async refreshSession() {return {data:{session:liveSession},error:null};},
      async signOut() {return {error:null};},
    }};
  };
  const riskGuardFactory = () => ({
    async claim(email, request) {
      calls.claim++; calls.email = email;
      return claim ? claim(email,request) : {allowed:true,retryAfterSeconds:0,
        accountKey:'a:'.padEnd(66,'a'),sourceKey:null};
    },
    async record(context,success) {
      calls.record++; return record ? record(context,success) : {action:'record'};
    },
  });
  const handler = createAuthHandler({env,supabaseFactory,riskGuardFactory});
  const request = (action = 'login', body = goodBody, headers = {}) => ({
    method:'POST', query:{action}, body, headers:{
      origin:'https://skt-aleph-defense.vercel.app',
      'content-type':'application/json','sec-fetch-site':'same-origin', ...headers
    },...extra
  });
  const invoke = async (input = request()) => {
    const headers = {};
    const res = {code:200,headers,jsonBody:undefined,
      setHeader(k,v) {headers[k.toLowerCase()]=v;return this;},
      status(v) {this.code=v;return this;},
      json(obj) {this.jsonBody=obj;return this;},
    };
    await handler(input,res);
    return res;
  };
  return {calls,request,invoke};
}

test('valid login claims atomic quota first, records verified success and rotates secure cookie',async()=>{
  const {calls,invoke}=harness();
  const response=await invoke();
  assert.equal(response.code,200);
  assert.equal(calls.signIn,1);assert.equal(calls.claim,1);assert.equal(calls.record,1);
  assert.equal(calls.email,goodBody.email);
  assert.match(response.headers['set-cookie'],/HttpOnly/);
  assert.match(response.headers['set-cookie'],/SameSite=Strict/);
  assert.match(response.headers['set-cookie'],/Secure/);
  assert.match(response.headers['set-cookie'],/Path=\/api\/auth/);
  assert.equal(response.headers['cache-control'],'no-store');
  assert.equal(response.jsonBody.accessToken,'fake-access-token');
  assert.ok(!JSON.stringify(response.headers).includes(goodBody.password));
});

test('rate guard blocks before password verifier; Retry-After and no credentials leaked',async()=>{
  const {invoke,calls}=harness({claim:()=>({allowed:false,retryAfterSeconds:42})});
  const response=await invoke();
  assert.equal(response.code,429);
  assert.deepEqual(response.jsonBody,{error:'AUTH_RATE_LIMITED'});
  assert.equal(response.headers['retry-after'],'42');
  assert.equal(calls.signIn,0);assert.equal(calls.record,0);
});

test('origin and fetch metadata block login CSRF before calling backend',async()=>{
  const {invoke,request,calls}=harness();
  const a=await invoke(request('login',goodBody,{origin:'https://evil.example'}));
  const b=await invoke(request('logout',null,{'sec-fetch-site':'cross-site'}));
  assert.equal(a.code,403);assert.equal(b.code,403);
  assert.equal(calls.backend,0);
});

test('large, unexpected and malformed body blocked without counting passwords',async()=>{
  const {invoke,request,calls}=harness();
  const invalid=[
    {email:'ok@example.com',password:'a',role:'instructor'},
    {email:'ok@example.com',password:'a',deviceApproved:true},
    {email:'bad@example.com <script>alert(1)</script>',password:'a'},
    {email:'ok@example.com',password:'a'.repeat(4097)},
  ];
  for(const row of invalid) {
    const res=await invoke(request('login',row));
    assert.equal(res.code,400);
  }
  const res=await invoke(request('login',goodBody,{'content-length':'1000000'}));
  assert.equal(res.code,413);
  const media=await invoke(request('login',goodBody,{'content-type':'text/plain'}));
  assert.equal(media.code,415);
  assert.equal(calls.claim,0);assert.equal(calls.signIn,0);
});

test('bad credentials have constant generic error, no provider message',async()=>{
  const {invoke,calls}=harness({signIn:()=>({data:{},error:{message:'user account x does not exist'}})});
  const res=await invoke();
  assert.equal(res.code,401);
  assert.deepEqual(res.jsonBody,{error:'LOGIN_FAILED'});
  assert.equal(calls.record,1);
  assert.ok(!JSON.stringify(res).includes('account x'));
});

test('no SQL rate guard means fail-closed without falling through to provider',async()=>{
  const {invoke,calls}=harness({claim:()=>{throw new Error('database down')}});
  const res=await invoke();
  assert.equal(res.code,503);
  assert.equal(res.jsonBody.error,'AUTH_RISK_GUARD_UNAVAILABLE');
  assert.equal(calls.signIn,0);
});

test('duplicate cookies never override authenticated session; csrf on refresh',async()=>{
  const {invoke,request}=harness();
  const dup=await invoke(request('session',null,{cookie:'aleph_refresh=one; aleph_refresh=two'}));
  assert.equal(dup.code,401);
  const evil=await invoke(request('session',null,{origin:'https://evil.example',
    cookie:'aleph_refresh=valid'}));
  assert.equal(evil.code,403);
});

test('known XDR judge outputs used for verified failed-login counts, not user supplied role/IP',()=>{
  assert.equal(classifyVerifiedLoginFailures({count:1,source:'198.51.100.3',key:'a:foo'}).action,'record');
  const a=classifyVerifiedLoginFailures({count:2,source:'198.51.100.3',key:'a:fff'});
  const b=classifyVerifiedLoginFailures({count:20,source:'198.51.100.3',key:'a:fff'});
  assert.equal(a.action,'alert');
  assert.equal(b.action,'block');
  assert.equal(b.reason,'rapid_source_login_failures');
  assert.equal(classifyVerifiedLoginFailures({count:50,key:'a:fff'}).action,'record');
  assert.equal(verifiedEdgeAddress({headers:{'x-forwarded-for':'198.51.100.3'}},env),null);
  assert.equal(verifiedEdgeAddress({headers:{'x-vercel-forwarded-for':'198.51.100.3'}},env),
    '198.51.100.3');
  assert.equal(suspiciousAuthInput('bad@example.com <script>alert(1)</script>',
    '198.51.100.3').action,'alert');
  assert.equal(validLoginInput(goodBody),true);
});

test('guard sends only HMAC keys, never account or IP to RPC',async()=>{
  const captured=[];
  const mockFactory=()=>({rpc:async(name,args)=>{
    captured.push({name,args});
    if(name==='s12_auth_claim') return {data:{allowed:true,retryAfterSeconds:0},error:null};
    return {data:{accountFailures:20,sourceFailures:20},error:null};
  }});
  const guard=createAuthRiskGuard({env,supabaseFactory:mockFactory});
  const req={headers:{'x-vercel-forwarded-for':'198.51.100.30'}};
  const ctx=await guard.claim('learner@example.com',req);
  const score=await guard.record(ctx,false);
  assert.equal(score.action,'block');
  assert.equal(captured.length,2);
  assert.ok(captured[0].args.p_account_key.startsWith('a:'));
  assert.ok(captured[0].args.p_source_key.startsWith('s:'));
  assert.doesNotMatch(JSON.stringify(captured),/learner@example\.com|198\.51\.100\.30|strong@examplePass/u);
});
