import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAuthCookieGeneration } from '../src/auth-cookie-generation.mjs';
const env={SUPABASE_SECRET_KEY:'long-synthetic-service-key-only-for-tests',VERCEL:'1'};
const bytes=()=>({setHeader(n,v){this[n]=v;}});
const jar=new Map();
function applyHeaders(arr){for(const header of arr){const [first,...attrs]=header.split(';');const [name,...parts]=first.split('=');const value=parts.join('=');if(attrs.some(a=>/Max-Age=0/.test(a)))jar.delete(name);else jar.set(name,value);}}
const serialize=()=>Array.from(jar,([n,v])=>`${n}=${v}`).join('; ');
test('ordered allocation and multi cookie parse',async()=>{
 let seq=0;const api=createAuthCookieGeneration({env,nextGeneration:async()=>String(++seq)});
 const first=await api.next(); const a=bytes();api.write(a,api.parse(''),first,{token:'first-token'});
 applyHeaders(a['Set-Cookie']);const second=await api.next();const b=bytes();api.write(b,api.parse(serialize()),second,{token:'second-token'});
 applyHeaders(b['Set-Cookie']);applyHeaders(a['Set-Cookie']); // delayed first response cannot replace the newer signed slot
 assert.equal(api.refreshToken(api.parse(serialize())),'second-token');
 assert.equal(api.parse(serialize()).selected.generation,2n);
 assert.equal(jar.has('aleph_refresh'),false);
 assert.equal(a['Set-Cookie'].every(s=>/HttpOnly; SameSite=Strict; Path=\/api\/auth/.test(s)),true);
 assert.equal(a['Set-Cookie'].every(s=>/Secure/.test(s)),true);
});
test('tombstone after logout dominates delayed refresh',async()=>{
 jar.clear();let seq=0;const api=createAuthCookieGeneration({env,nextGeneration:async()=>String(++seq)});
 const init=bytes();api.write(init,api.parse(''),await api.next(),{token:'old'});applyHeaders(init['Set-Cookie']);
 const slow=bytes();api.write(slow,api.parse(serialize()),await api.next(),{token:'rotated'});
 const logout=bytes();api.write(logout,api.parse(serialize()),await api.next(),{revoked:true});
 applyHeaders(logout['Set-Cookie']);applyHeaders(slow['Set-Cookie']);
 const chosen=api.parse(serialize());assert.equal(chosen.selected.generation,3n);assert.equal(chosen.selected.kind,'x');
 assert.equal(api.refreshToken(chosen),null);
});
test('signed cookie cannot be forged to select a higher generation',async()=>{
 jar.clear();const api=createAuthCookieGeneration({env,nextGeneration:async()=> '4'});
 const good=bytes();api.write(good,api.parse(''),await api.next(),{token:'original'});applyHeaders(good['Set-Cookie']);
 const corrupt=serialize()+'; aleph_auth_g_z999=r.fakesignature.new';
 assert.equal(api.parse(corrupt).invalid,true);
 const tamper=serialize().replace(/(aleph_auth_g_4=r\.[^;]*\.)original/u, '$1attacker');assert.equal(api.parse(tamper).invalid,true);
});
test('malformed, duplicated, too many cookies rejected and no legacy fallback',async()=>{
 const api=createAuthCookieGeneration({env,nextGeneration:async()=> '5'});
 const first=bytes();api.write(first,api.parse(''),await api.next(),{token:'valid'});
 applyHeaders(first['Set-Cookie']);const raw=serialize();
 for(const cookie of [raw+'; aleph_auth_g_5=invalid',raw+'; aleph_auth_g_oops=r.xxx.invalid', raw+'; aleph_auth_g_z999=x.nope.', raw.repeat(150)]){
  assert.equal(api.parse(cookie).invalid,true);
 }
});
test('allocator RPC yields exact integer string and fails closed',async()=>{
 const api=createAuthCookieGeneration({env,supabaseFactory:()=>({rpc:async()=>({data:'7',error:null})})});assert.equal((await api.next()).generation,7n);
 for(const bad of [null,8, '0','001','9007199254740992']){
  const failing=createAuthCookieGeneration({env,supabaseFactory:()=>({rpc:async()=>({data:bad,error:null})})});
  await assert.rejects(failing.next(),/AUTH_GENERATION_UNAVAILABLE/);
 }
});

test('an allocator result after its monotonic deadline is rejected even before timer delivery',async()=>{
 let now=0;
 const api=createAuthCookieGeneration({env,monotonic:()=>now,supabaseFactory:()=>({rpc:()=>{now=8001;return Promise.resolve({data:'7',error:null});}})});
 await assert.rejects(api.next(),/AUTH_GENERATION_UNAVAILABLE/);
});
