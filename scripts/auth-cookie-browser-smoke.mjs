// Real Chromium CookieJar + HTTP fixture for delayed Set-Cookie ordering.
// No live Supabase, external domains, privilege escalation or attack simulation.
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createAuthHandler} from '../api/auth.js';
import {createAuthCookieGeneration} from '../src/auth-cookie-generation.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
const deferred = () => {let release;const promise=new Promise(r=>{release=r;});return {promise,release};};
async function until(predicate,description,timeout=14000){
 const deadline=Date.now()+timeout;
 while(Date.now()<deadline){if(await predicate())return;await pause(40);}
 throw Error('Synthetic browser deadline: '+description);
}

async function main(){
 const env={SUPABASE_URL:'https://synthetic.invalid',SUPABASE_PUBLISHABLE_KEY:'synthetic-only',
   SUPABASE_SECRET_KEY:'synthetic-generation-32-bytes-no-production',
   AUTH_COOKIE_GENERATION_MODE:'enforce'};
 let sequence=0;
 const gates={};const entered=[];
 const factory=()=>({auth:{
   async signInWithPassword({email}){
     const who=email.split('@')[0];entered.push('login:'+who);
     if(gates['login:'+who])await gates['login:'+who].promise;
     return {data:{session:{access_token:'access-'+who,refresh_token:'refresh-'+who,
       expires_at:1800000000,user:{email}}},error:null};
   },
   async refreshSession({refresh_token}){
     const who=refresh_token.replace(/^(?:refresh-|next-)/u,'');entered.push('session:'+who);
     if(gates['session:'+who] && entered.filter(v=>v==='session:'+who).length===1)
       await gates['session:'+who].promise;
     return {data:{session:{access_token:'access-'+who,refresh_token:'next-'+who,
       expires_at:1800000000,user:{email:who+'@example.invalid'}}},error:null};
   },
   async signOut(){return {error:null};},
 }});
 const generationFactory=()=>createAuthCookieGeneration({env,nextGeneration:async()=>String(++sequence)});
 const handler=createAuthHandler({env,supabaseFactory:factory,generationFactory,
   riskGuardFactory:()=>({claim:async()=>({allowed:true}),record:async()=>{}})});
 const server=http.createServer(async(req,res)=>{
   const url=new URL(req.url,'http://127.0.0.1');
   if(url.pathname==='/'){
     res.writeHead(200,{'content-type':'text/html','cache-control':'no-store'});
     res.end('<!doctype html><html><title>Claire cookie generation QA</title><script>window.callAuth=async (action,who="alice")=>{const r=await fetch("/api/auth/"+action,{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:who+"@example.invalid",password:"synthetic-fixture"})});return {status:r.status,body:await r.json()}}</script></html>');return;
   }
   if(!['/api/auth/login','/api/auth/logout','/api/auth/session'].includes(url.pathname)){
     res.writeHead(404);res.end();return;
   }
   const chunks=[];for await(const chunk of req) chunks.push(chunk);
   const body=Buffer.concat(chunks).toString('utf8');
   const publicOrigin='https://skt-aleph-defense.vercel.app';
   const request={method:'POST',query:{action:url.pathname.split('/').at(-1)},
     body:body?JSON.parse(body):null,
     headers:{...req.headers,origin:publicOrigin,'sec-fetch-site':'same-origin'}};
   const headers={};let code=200,reply=null;
   const mocked={setHeader(name,value){headers[name]=value;return this;},
     status(value){code=value;return this;},json(value){reply=value;return this;}};
   try{await handler(request,mocked);res.writeHead(code,headers);res.end(JSON.stringify(reply));}
   catch {res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:'FIXTURE_FAILED'}));}
 });
 let chrome,dir,socket;const pending=new Map(),errors=[];let nextId=0;
 try{
   await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
   const origin='http://127.0.0.1:'+server.address().port;
   dir=await mkdtemp(join(tmpdir(),'claire-cookie-smoke-'));
   chrome=spawn(process.env.CLAIRE_CHROME_BIN||'google-chrome',['--headless=new','--no-sandbox','--disable-dev-shm-usage',
     '--disable-extensions','--no-first-run','--remote-debugging-port=0','--user-data-dir='+dir,'about:blank'],{stdio:'ignore'});
   let port;
   await until(async()=>{if(chrome.exitCode!==null)throw Error('Chrome exited');try{port=Number((await readFile(join(dir,'DevToolsActivePort'),'utf8')).split('\n')[0]);}catch{}return Number.isInteger(port)&&port>0},'chrome ready');
   const pages=await(await fetch('http://127.0.0.1:'+port+'/json')).json();
   const tab=pages.find(p=>p.type==='page');assert.ok(tab?.webSocketDebuggerUrl);
   socket=new WebSocket(tab.webSocketDebuggerUrl);
   await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject});
   socket.onmessage=event=>{
     const data=JSON.parse(event.data);
     if(data.method==='Runtime.exceptionThrown')errors.push(data.params.exceptionDetails.text);
     if(pending.has(data.id)){pending.get(data.id)(data);pending.delete(data.id);}
   };
   const cmd=async(method,params={})=>{
     const id=++nextId;
     const answer=await new Promise((resolve,reject)=>{
       const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timed out '+method));},15000);
       pending.set(id,result=>{clearTimeout(timer);resolve(result)});
       socket.send(JSON.stringify({id,method,params}));
     });
     if(answer.error)throw Error(method+': '+answer.error.message);
     return answer.result;
   };
   const evalJS=async(expression)=>{
     const result=await cmd('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
     if(result.exceptionDetails)throw Error('Browser exception: '+result.exceptionDetails.text);
     return result.result?.value;
   };
   await cmd('Page.enable');await cmd('Runtime.enable');await cmd('Network.enable');
   await cmd('Page.navigate',{url:origin+'/'});
   await until(async()=>Boolean(await evalJS('typeof window.callAuth === "function"')),'fixture loaded');
   // First response is delayed in provider; second sets its cookies earlier.
   gates['login:alice']=deferred();
   await evalJS('window.first=callAuth("login","alice");true');
   await until(()=>entered.includes('login:alice'),'first auth entered');
   const newer=await evalJS('callAuth("login","bob")');
   assert.equal(newer.status,200);
   gates['login:alice'].release();
   assert.equal((await evalJS('window.first')).status,200);
   const restored=await evalJS('callAuth("session")');
   assert.equal(restored.status,200);assert.equal(restored.body.user.email,'bob@example.invalid');
   const cookies=await cmd('Network.getCookies',{urls:[origin+'/api/auth/session']});
   const generated=cookies.cookies.filter(c=>c.name.startsWith('aleph_auth_g_'));
   assert.ok(generated.length>0);
   assert.ok(generated.every(c=>c.httpOnly && c.sameSite==='Strict'));
   assert.equal(await evalJS('document.cookie.includes("aleph_auth_g_")'),false);
   // Delayed refresh headers can no longer re-authenticate after a newer logout.
   await cmd('Network.clearBrowserCookies');
   gates['login:alice']=null;
   assert.equal((await evalJS('callAuth("login","alice")')).status,200);
   gates['session:alice']=deferred();
   await evalJS('window.oldSession=callAuth("session");true');
   await until(()=>entered.includes('session:alice'),'old session entered');
   const logout=await evalJS('callAuth("logout")');assert.equal(logout.status,200);
   gates['session:alice'].release();
   assert.equal((await evalJS('window.oldSession')).status,200);
   const after=await evalJS('callAuth("session")');
   assert.equal(after.status,401);assert.deepEqual(after.body,{error:'NO_SESSION'});
   assert.deepEqual(errors,[]);
   console.log('PASS Chromium real HttpOnly CookieJar: late login and refresh do not override new login or logout; legacy JSON API is unchanged.');
 } finally {
   if(socket?.readyState===WebSocket.OPEN)socket.close();
   if(chrome&&chrome.exitCode===null){const stop=once(chrome,'exit').catch(()=>{});chrome.kill('SIGTERM');await Promise.race([stop,pause(2500)]);if(chrome.exitCode===null)chrome.kill('SIGKILL');}
   if(dir)await rm(dir,{recursive:true,force:true,maxRetries:4,retryDelay:150}).catch(()=>{});
   await new Promise(resolve=>server.close(resolve));server.closeIdleConnections?.();
 }
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
