import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAuthHandler } from '../api/auth.js';
import { createAuthCookieGeneration } from '../src/auth-cookie-generation.mjs';

// All credentials in this suite are synthetic and never reach a live service.
const env = {
  SUPABASE_URL: 'https://synthetic.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-pub',
  SUPABASE_SECRET_KEY: 'synthetic-generation-secret-32-bytes-only',
  AUTH_COOKIE_GENERATION_MODE: 'enforce', VERCEL: '1',
};
const deferred = () => {let resolve; const promise = new Promise(r => {resolve=r;}); return {resolve,promise};};
function response() {
  return {headers:{},setHeader(k,v){this.headers[k.toLowerCase()]=v;},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
}
function createBrowser() {
  const jar=new Map();
  return {
    cookie: () => [...jar].map(([n,v])=>n+'='+v).join('; '),
    apply(res) {
      const cookies=res.headers['set-cookie'];
      for(const cookie of typeof cookies==='string'?[cookies]:cookies||[]){
        const [pair,...attrs]=cookie.split(';');const eq=pair.indexOf('=');
        const name=pair.slice(0,eq),value=pair.slice(eq+1);
        if(attrs.some(a=>/Max-Age=0/u.test(a)))jar.delete(name);else jar.set(name,value);
      }
    },
    names:()=> [...jar.keys()],
  };
}
function makeFixture({mode='enforce',fault=null}={}) {
  let next=0;const gate=new Map(),subjects=[];
  const config={...env,AUTH_COOKIE_GENERATION_MODE:mode};
  const factory=()=>({auth:{
    async signInWithPassword({email}) {
      const who=email.split('@')[0];subjects.push('login:'+who);
      if(gate.has('login:'+who))await gate.get('login:'+who).promise;
      return {data:{session:{access_token:'access-'+who,refresh_token:'refresh-'+who,
        user:{email},expires_at:1793000000}},error:null};
    },
    async refreshSession({refresh_token}) {
      const who=refresh_token.replace('refresh-','').replace('next-','');
      subjects.push('session:'+who);
      if(gate.has('session:'+who) && subjects.filter(x=>x==='session:'+who).length===1)await gate.get('session:'+who).promise;
      return {data:{session:{access_token:'access-'+who,refresh_token:'next-'+who,
        user:{email:who+'@example.invalid'},expires_at:1793000000}},error:null};
    },
    async signOut(){subjects.push('signOut');return {error:null};},
  }});
  const generate=()=>createAuthCookieGeneration({env:config,nextGeneration:async()=>{
    if(fault==='db-error')throw Error('synthetic generation DB outage');
    return String(++next);
  }});
  const handler=()=>createAuthHandler({env:config,supabaseFactory:factory,
    generationFactory:generate,
    riskGuardFactory:()=>({claim:async()=>({allowed:true}),record:async()=>{}})});
  async function run(h,action,browser,who='alice'){
    const req={method:'POST',query:{action},headers:{'content-type':'application/json',
      cookie:browser.cookie(),origin:'https://skt-aleph-defense.vercel.app','sec-fetch-site':'same-origin'},
      body:{email:who+'@example.invalid',password:'synthetic'} };
    const res=response();await h(req,res);return res;
  }
  return {handler,run,gate,subjects,get count(){return next;}};
}
const tick=()=>new Promise(r=>setImmediate(r));

test('late old login cookie cannot overwrite newer login across serverless handlers',async()=>{
  const x=makeFixture(),browser=createBrowser();const hold=deferred();x.gate.set('login:alice',hold);
  const older=x.run(x.handler(),'login',browser,'alice');await tick();
  const newer=await x.run(x.handler(),'login',browser,'bob');browser.apply(newer);
  hold.resolve();const old=await older;browser.apply(old);
  assert.equal(x.count,2);assert.equal(old.code,200);assert.equal(newer.code,200);
  assert.equal(old.body.user.email,'alice@example.invalid');
  const restored=await x.run(x.handler(),'session',browser);
  assert.equal(restored.code,200);assert.equal(restored.body.user.email,'bob@example.invalid');
  assert.equal(x.subjects.at(-1),'session:bob');
  assert.ok(browser.names().some(name=>name.startsWith('aleph_auth_g_')));
});

test('logout tombstone beats an older delayed login even when no cookie existed at logout',async()=>{
  const x=makeFixture(),jar=createBrowser(),hold=deferred();x.gate.set('login:alice',hold);
  const old=x.run(x.handler(),'login',jar);await tick();
  const logout=await x.run(x.handler(),'logout',jar);assert.equal(logout.code,200);
  jar.apply(logout);hold.resolve();jar.apply(await old);
  const restore=await x.run(x.handler(),'session',jar);
  assert.equal(restore.code,401);assert.deepEqual(restore.body,{error:'NO_SESSION'});
  assert.equal(x.subjects.includes('session:alice'),false);
});

test('late refresh cannot undo later logout; new login after logout still succeeds',async()=>{
  const x=makeFixture(),jar=createBrowser(),h=x.handler();
  jar.apply(await x.run(h,'login',jar,'alice'));
  const hold=deferred();x.gate.set('session:alice',hold);
  const pending=x.run(h,'session',jar);await tick();
  const logout=await x.run(x.handler(),'logout',jar);jar.apply(logout);
  hold.resolve();jar.apply(await pending);
  assert.equal((await x.run(h,'session',jar)).code,401);
  jar.apply(await x.run(x.handler(),'login',jar,'bob'));
  const newer=await x.run(x.handler(),'session',jar);
  assert.equal(newer.code,200);assert.equal(newer.body.user.email,'bob@example.invalid');
});

test('legacy client sends identical request/receives identical JSON and cookie when guard disabled',async()=>{
  const x=makeFixture({mode:'legacy'}),jar=createBrowser();
  const res=await x.run(x.handler(),'login',jar,'alice');
  assert.equal(res.code,200);
  assert.deepEqual(Object.keys(res.body).sort(), ['accessToken','expiresAt','user']);
  assert.equal(typeof res.headers['set-cookie'],'string');
  jar.apply(res);
  assert.equal((await x.run(x.handler(),'session',jar)).code,200);
  assert.equal((await x.run(x.handler(),'logout',jar)).code,200);
});

test('generation outage fails closed without reaching Supabase Auth, and reveals no credentials',async()=>{
  const x=makeFixture({fault:'db-error'}),jar=createBrowser();
  const res=await x.run(x.handler(),'login',jar);
  assert.equal(res.code,503);assert.deepEqual(res.body,{error:'AUTH_GENERATION_UNAVAILABLE'});
  assert.equal(x.subjects.length,0);assert.equal(res.headers['set-cookie'],undefined);
  assert.doesNotMatch(JSON.stringify(res),/synthetic-generation-secret|synthetic@/u);
  const logout=await x.run(x.handler(),'logout',jar);
  assert.equal(logout.code,503);assert.match(logout.headers['set-cookie'],/Max-Age=0/u);
});

test('disabled feature for existing environment does not require a new RPC',async()=>{
  const x=makeFixture({mode:'legacy',fault:'db-error'}),jar=createBrowser();
  const res=await x.run(x.handler(),'login',jar);assert.equal(res.code,200);
});

test('ambiguous version cookie fails closed on session but deliberate login can recover',async()=>{
  const x=makeFixture(),jar=createBrowser(),h=x.handler();
  jar.apply(await x.run(h,'login',jar));
  jar.apply({headers:{'set-cookie':['aleph_auth_g_deadbeef=r.invalid.malformed; HttpOnly; Path=/api/auth']}});
  const bad=await x.run(h,'session',jar);
  assert.equal(bad.code,401);
  assert.equal(x.subjects.filter(s=>s.startsWith('session:')).length,0);
  const recovery=await x.run(h,'login',jar,'bob');jar.apply(recovery);
  const renewed=await x.run(h,'session',jar);
  assert.equal(renewed.code,200);assert.equal(renewed.body.user.email,'bob@example.invalid');
});

test('logout keeps signed tombstone even when auth backend cannot be configured',async()=>{
  let next=0;
  const local={...env,SUPABASE_PUBLISHABLE_KEY:undefined};
  const handler=createAuthHandler({env:local,
    generationFactory:()=>createAuthCookieGeneration({env:local,nextGeneration:async()=>String(++next)}),
    supabaseFactory:()=>{throw Error('should not reach provider');}});
  const jar=createBrowser();const res=response();
  await handler({method:'POST',query:{action:'logout'},headers:{cookie:jar.cookie()}},res);
  assert.equal(res.code,503);assert.equal(res.body.error,'AUTH_BACKEND_NOT_CONFIGURED');
  assert.ok(Array.isArray(res.headers['set-cookie']));
  assert.ok(res.headers['set-cookie'].some(c=>/aleph_auth_g_1=x\./u.test(c)));
  jar.apply(res);
  const gen=createAuthCookieGeneration({env:local,nextGeneration:async()=>String(++next)});
  assert.equal(gen.parse(jar.cookie()).selected.kind,'x');
});

test('production defaults to fail closed generation enforcement when RPC is unavailable',async()=>{
  const config={...env,NODE_ENV:'production',AUTH_COOKIE_GENERATION_MODE:undefined};
  let called=0;
  const h=createAuthHandler({env:config,
    generationFactory:()=>createAuthCookieGeneration({env:config,nextGeneration:async()=>{throw Error('offline');}}),
    riskGuardFactory:()=>({claim:async()=>({allowed:true}),record:async()=>{}}),
    supabaseFactory:()=>({auth:{signInWithPassword(){called++;}}})});
  const res=response();
  await h({method:'POST',query:{action:'login'},headers:{'content-type':'application/json'},
    body:{email:'alice@example.invalid',password:'test-only'}},res);
  assert.equal(res.code,503);assert.equal(res.body.error,'AUTH_GENERATION_UNAVAILABLE');assert.equal(called,0);
});
