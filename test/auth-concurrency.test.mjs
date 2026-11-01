import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClient } from '@supabase/supabase-js';
import { createAuthHandler } from '../api/auth.js';

// All users and credentials in this file are synthetic and never leave this transport.
function harness() {
  let releaseFirst, signalFirst;
  const firstEntered = new Promise(resolve => { signalFirst = resolve; });
  const gate = new Promise(resolve => { releaseFirst = resolve; });
  const refreshCalls = [];
  const signOutSubjects = [];
  const ownerIds = {
    alpha:'11111111-1111-4111-8111-111111111111',
    beta:'22222222-2222-4222-8222-222222222222',
    gamma:'33333333-3333-4333-8333-333333333333',
    invalid:'not-a-uuid',
  };
  const session = who => ({
    access_token: `fixture-access-${who}`,
    refresh_token: `fixture-rotated-${who}`,
    token_type: 'bearer', expires_in: 3600,
    user: { id: ownerIds[who], email: `${who}@example.invalid` },
  });
  const transport = async (url, init = {}) => {
    const path = new URL(String(url));
    if (path.pathname.endsWith('/logout')) {
      signOutSubjects.push(new Headers(init.headers).get('authorization'));
      return new Response(null, { status: 204 });
    }
    assert.ok(path.pathname.endsWith('/token'), 'unexpected synthetic request');
    const body = JSON.parse(init.body);
    const grant = path.searchParams.get('grant_type');
    let who;
    if (grant === 'refresh_token') {
      who = String(body.refresh_token).replace('fixture-refresh-', '');
      refreshCalls.push(who);
      if (who === 'alpha') { signalFirst(); await gate; }
    } else {
      assert.equal(grant, 'password');
      who = body.email.split('@')[0];
    }
    return new Response(JSON.stringify(session(who)), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  const factory = (url, key, options) => createClient(url, key, {
    ...options, global: { fetch: transport },
  });
  const handler = createAuthHandler({
    env: { SUPABASE_URL: 'https://fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'fixture-only' },
    supabaseFactory: factory,
    riskGuardFactory: () => ({ claim: async () => ({ allowed: true }), record: async () => {} }),
  });
  async function request(action, who) {
    const result = {
      headers: {},
      setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
      status(code) { this.code = code; return this; },
      json(body) { this.body = body; return this; },
    };
    const input = {
      method: 'POST', query: { action },
      headers: action === 'login'
        ? { 'content-type': 'application/json' }
        : { cookie: `aleph_refresh=fixture-refresh-${who}` },
      ...(action === 'login' ? { body: { email: `${who}@example.invalid`, password: 'synthetic-only-value' } } : {}),
    };
    await handler(input, result);
    return result;
  }
  return { request, firstEntered, releaseFirst, refreshCalls, signOutSubjects };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('simultaneous refreshes for different users return their own session and cookie', async () => {
  const x = harness();
  const alpha = x.request('session', 'alpha');
  await x.firstEntered;
  const beta = x.request('session', 'beta');
  await tick(); await tick();
  x.releaseFirst();
  const [a, b] = await Promise.all([alpha, beta]);
  assert.equal(a.code, 200);
  assert.equal(b.code, 200);
  assert.equal(a.body.user.email, 'alpha@example.invalid');
  assert.equal(b.body.user.email, 'beta@example.invalid');
  assert.match(a.headers['set-cookie'], /fixture-rotated-alpha/);
  assert.match(b.headers['set-cookie'], /fixture-rotated-beta/);
  assert.deepEqual(x.refreshCalls.sort(), ['alpha', 'beta']);
});

test('a concurrent logout revokes only its own user while another user refreshes', async () => {
  const x = harness();
  const alpha = x.request('session', 'alpha');
  await x.firstEntered;
  const beta = x.request('logout', 'beta');
  await tick(); await tick();
  x.releaseFirst();
  const [a, b] = await Promise.all([alpha, beta]);
  assert.equal(a.code, 200);
  assert.equal(b.code, 200);
  assert.equal(a.body.user.email, 'alpha@example.invalid');
  assert.deepEqual(x.refreshCalls.sort(), ['alpha', 'beta']);
  assert.deepEqual(x.signOutSubjects, ['Bearer fixture-access-beta']);
});

test('login, another user refresh and a third user logout retain independent identities', async () => {
  const x = harness();
  const alpha = x.request('session', 'alpha');
  await x.firstEntered;
  const beta = x.request('logout', 'beta');
  const gamma = x.request('login', 'gamma');
  await tick(); await tick();
  x.releaseFirst();
  const [a, b, c] = await Promise.all([alpha, beta, gamma]);
  assert.equal(a.code, 200);
  assert.equal(b.code, 200);
  assert.equal(c.code, 200);
  assert.equal(a.body.user.email, 'alpha@example.invalid');
  assert.equal(c.body.user.email, 'gamma@example.invalid');
  assert.match(a.headers['set-cookie'], /fixture-rotated-alpha/);
  assert.match(c.headers['set-cookie'], /fixture-rotated-gamma/);
  assert.deepEqual(x.signOutSubjects, ['Bearer fixture-access-beta']);
});

test('successful auth exposes the provider owner ID only when it is a valid UUID', async () => {
  const x=harness();
  const valid=await x.request('login','gamma');
  const missing=await x.request('login','missing');
  const invalid=await x.request('login','invalid');
  assert.equal(valid.code,200);
  assert.equal(valid.body.user.id,'33333333-3333-4333-8333-333333333333');
  for(const result of [missing,invalid]){
    assert.equal(result.code,200);
    assert.equal(Object.hasOwn(result.body.user,'id'),false);
  }
});

async function refreshWithTransport(mode) {
  const previousNow=Date.now;let clock=1800000000000;
  Date.now=()=>{clock+=60000;return clock;};
  try{
    const transport=async()=>{
      if(mode==='network')throw Error('synthetic network error');
      if(mode==='invalid-success')return new Response('{invalid',{status:200,headers:{'content-type':'application/json'}});
      const status=mode==='provider-503'?503:mode==='rate-limit'?429:mode==='revoked-401'?401:400;
      const code=mode==='revoked'||mode==='revoked-401'?'refresh_token_not_found':
        mode==='session-missing'?'session_not_found':mode==='rate-limit'?'over_request_rate_limit':'unexpected_failure';
      return new Response(JSON.stringify({code,msg:'synthetic provider detail'}),{
        status,headers:{'content-type':'application/json','x-supabase-api-version':'2024-01-01'},
      });
    };
    const handler=createAuthHandler({
      env:{SUPABASE_URL:'https://fixture.invalid',SUPABASE_PUBLISHABLE_KEY:'fixture-only'},
      supabaseFactory:(url,key,options)=>createClient(url,key,{...options,global:{fetch:transport}}),
    });
    const result={headers:{},setHeader(name,value){this.headers[name.toLowerCase()]=value;},
      status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
    await handler({method:'POST',query:{action:'session'},headers:{cookie:'aleph_refresh=fixture-refresh'}},result);
    return result;
  } finally { Date.now=previousNow; }
}
for(const mode of ['network','provider-503','rate-limit','invalid-success','unknown-400']){
  test(`refresh ${mode} is unavailable without deleting the cookie`,async()=>{
    const response=await refreshWithTransport(mode);
    assert.equal(response.code,503);
    assert.equal(response.body.error,'AUTH_BACKEND_UNAVAILABLE');
    assert.equal(Object.hasOwn(response.headers,'set-cookie'),false);
    assert.equal(JSON.stringify(response.body).includes('synthetic provider detail'),false);
  });
}
for(const mode of ['revoked','revoked-401','session-missing']){
  test(`an explicit provider ${mode} rejection clears the cookie`,async()=>{
    const response=await refreshWithTransport(mode);
    assert.equal(response.code,401);
    assert.equal(response.body.error,'SESSION_EXPIRED');
    assert.match(response.headers['set-cookie'],/Max-Age=0/);
  });
}

async function logoutWithFailure(mode){
  const cleared={access_token:'fixture-access',refresh_token:'fixture-refresh-next'};
  let signOutCalls=0;
  const auth={
    async refreshSession(){
      if(mode==='refresh-throw')throw Error('synthetic provider failure');
      if(mode==='refresh-error')return {data:{session:null},error:Error('synthetic provider failure')};
      if(mode==='missing-session')return {data:{session:null},error:null};
      return {data:{session:cleared},error:null};
    },
    async signOut(){
      signOutCalls++;
      if(mode==='signout-throw')throw Error('synthetic provider failure');
      return {error:mode==='signout-error'?Error('synthetic provider failure'):null};
    },
  };
  const handler=createAuthHandler({
    env:{SUPABASE_URL:'https://fixture.invalid',SUPABASE_PUBLISHABLE_KEY:'fixture-only'},
    supabaseFactory:()=>({auth}),
  });
  const result={headers:{},setHeader(name,value){this.headers[name.toLowerCase()]=value;},
    status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
  await handler({method:'POST',query:{action:'logout'},headers:{cookie:'aleph_refresh=fixture-refresh'}},result);
  return {result,signOutCalls};
}
for(const mode of ['refresh-throw','refresh-error','missing-session','signout-throw','signout-error']){
  test(`logout ${mode} clears the local cookie but reports unconfirmed remote logout`,async()=>{
    const {result,signOutCalls}=await logoutWithFailure(mode);
    assert.equal(result.code,503);
    assert.deepEqual(result.body,{error:'REMOTE_LOGOUT_UNCONFIRMED'});
    assert.match(result.headers['set-cookie'],/Max-Age=0/);
    assert.equal(signOutCalls,mode.startsWith('signout-')?1:0);
  });
}

test('logout without a refresh cookie remains a successful local logout',async()=>{
  let calls=0;
  const handler=createAuthHandler({
    env:{SUPABASE_URL:'https://fixture.invalid',SUPABASE_PUBLISHABLE_KEY:'fixture-only'},
    supabaseFactory:()=>({auth:{refreshSession(){calls++;throw Error('unexpected');}}}),
  });
  const result={headers:{},setHeader(name,value){this.headers[name.toLowerCase()]=value;},
    status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
  await handler({method:'POST',query:{action:'logout'},headers:{}},result);
  assert.equal(result.code,200);
  assert.deepEqual(result.body,{ok:true});
  assert.match(result.headers['set-cookie'],/Max-Age=0/);
  assert.equal(calls,0);
});

test('logout clears the local cookie even when the auth backend is not configured',async()=>{
  const handler=createAuthHandler({env:{}});
  const result={headers:{},setHeader(name,value){this.headers[name.toLowerCase()]=value;},
    status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
  await handler({method:'POST',query:{action:'logout'},headers:{cookie:'aleph_refresh=fixture-refresh'}},result);
  assert.equal(result.code,503);
  assert.deepEqual(result.body,{error:'AUTH_BACKEND_NOT_CONFIGURED'});
  assert.match(result.headers['set-cookie'],/Max-Age=0/);
});

test('logout clears the local cookie when auth client construction fails',async()=>{
  const handler=createAuthHandler({
    env:{SUPABASE_URL:'https://fixture.invalid',SUPABASE_PUBLISHABLE_KEY:'fixture-only'},
    supabaseFactory:()=>{throw Error('synthetic configuration detail');},
  });
  const result={headers:{},setHeader(name,value){this.headers[name.toLowerCase()]=value;},
    status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
  await handler({method:'POST',query:{action:'logout'},headers:{cookie:'aleph_refresh=fixture-refresh'}},result);
  assert.equal(result.code,503);
  assert.deepEqual(result.body,{error:'AUTH_BACKEND_NOT_CONFIGURED'});
  assert.match(result.headers['set-cookie'],/Max-Age=0/);
});

for(const action of ['login','session']){
  test(`${action} preserves cookies when auth client construction fails`,async()=>{
    const handler=createAuthHandler({
      env:{SUPABASE_URL:'https://fixture.invalid',SUPABASE_PUBLISHABLE_KEY:'fixture-only'},
      supabaseFactory:()=>{throw Error('synthetic configuration detail');},
    });
    const result={headers:{},setHeader(name,value){this.headers[name.toLowerCase()]=value;},
      status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
    await handler({method:'POST',query:{action},headers:{cookie:'aleph_refresh=fixture-refresh'}},result);
    assert.equal(result.code,503);
    assert.deepEqual(result.body,{error:'AUTH_BACKEND_NOT_CONFIGURED'});
    assert.equal(Object.hasOwn(result.headers,'set-cookie'),false);
  });
}

for(const providerStatus of [204,401,403,404,500]){
  test(`installed SDK logout response ${providerStatus} is reported within its observable limits`,async()=>{
    let logoutCalls=0;
    const transport=async url=>{
      const path=new URL(String(url));
      if(path.pathname.endsWith('/token'))return new Response(JSON.stringify({
        access_token:'fixture-access',refresh_token:'fixture-refresh-next',token_type:'bearer',expires_in:3600,
        user:{id:'11111111-1111-4111-8111-111111111111'},
      }),{headers:{'content-type':'application/json'}});
      if(path.pathname.endsWith('/logout')){
        logoutCalls++;
        return providerStatus===204?new Response(null,{status:204}):
          new Response(JSON.stringify({error:'synthetic provider detail'}),{
            status:providerStatus,headers:{'content-type':'application/json','x-supabase-api-version':'2024-01-01'},
          });
      }
      throw Error('unexpected synthetic request');
    };
    const handler=createAuthHandler({
      env:{SUPABASE_URL:'https://fixture.invalid',SUPABASE_PUBLISHABLE_KEY:'fixture-only'},
      supabaseFactory:(url,key,options)=>createClient(url,key,{...options,global:{fetch:transport}}),
    });
    const result={headers:{},setHeader(name,value){this.headers[name.toLowerCase()]=value;},
      status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
    await handler({method:'POST',query:{action:'logout'},headers:{cookie:'aleph_refresh=fixture-refresh'}},result);
    assert.equal(logoutCalls,1);
    assert.equal(result.code,providerStatus===500?503:200);
    assert.deepEqual(result.body,providerStatus===500?{error:'REMOTE_LOGOUT_UNCONFIRMED'}:{ok:true});
    assert.match(result.headers['set-cookie'],/Max-Age=0/);
    assert.doesNotMatch(JSON.stringify(result.body),/synthetic provider detail/);
  });
}
